package dev.kube.copilot.lab.order.service;

import dev.kube.copilot.lab.order.model.CustomerRecord;
import dev.kube.copilot.lab.order.model.DownstreamResponse;
import dev.kube.copilot.lab.order.model.OrderSummary;
import dev.kube.copilot.lab.order.repository.OrderLabRepository;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.StatusCode;
import io.opentelemetry.api.trace.Tracer;
import io.opentelemetry.context.Scope;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.LinkedHashMap;
import java.util.Map;

@Service
public class CheckoutPreviewService {

    private static final Logger log = LoggerFactory.getLogger(CheckoutPreviewService.class);
    private static final AttributeKey<String> SQL_TEMPLATE = AttributeKey.stringKey("db.query.template");
    private static final AttributeKey<String> QUERY_LABEL = AttributeKey.stringKey("db.query.label");

    private final OrderLabRepository repository;
    private final DownstreamCatalogClient downstreamCatalogClient;
    private final Tracer tracer;

    public CheckoutPreviewService(
            OrderLabRepository repository,
            DownstreamCatalogClient downstreamCatalogClient,
            Tracer tracer
    ) {
        this.repository = repository;
        this.downstreamCatalogClient = downstreamCatalogClient;
        this.tracer = tracer;
    }

    public Map<String, Object> checkoutPreview(String fault, String downstreamFault, int fanout, long userId, String tier) {
        long totalStartedAt = System.nanoTime();
        Span rootSpan = tracer.spanBuilder("order.checkout_preview").startSpan();
        try (Scope ignored = rootSpan.makeCurrent()) {
            rootSpan.setAttribute("fault.mode", fault);
            rootSpan.setAttribute("downstream.fault.mode", downstreamFault);
            rootSpan.setAttribute("fault.fanout", Math.max(1, fanout));
            rootSpan.setAttribute("order.user_id", userId);
            rootSpan.setAttribute("pricing.tier", tier);

            CustomerRecord customer = loadCustomer(userId);
            long dbStartedAt = System.nanoTime();
            OrderSummary orderSummary = "slow-sql".equals(fault) ? loadSlowSummary(userId) : repository.loadFastSummary(userId);
            long dbElapsedMs = nanosToMillis(dbStartedAt);

            long downstreamStartedAt = System.nanoTime();
            DownstreamResponse catalogResponse = downstreamCatalogClient.fetchCatalog(normalizeDownstreamFault(downstreamFault), Math.max(1, fanout), tier);
            long downstreamElapsedMs = nanosToMillis(downstreamStartedAt);

            if (catalogResponse.statusCode() >= 500) {
                rootSpan.setStatus(StatusCode.ERROR, "catalog downstream failure");
                rootSpan.setAttribute("http.downstream.status_code", catalogResponse.statusCode());
                throw new IllegalStateException("catalog-fault returned status " + catalogResponse.statusCode() + ": " + catalogResponse.bodyText());
            }

            if ("null-pointer".equals(fault)) {
                triggerNullPointer(rootSpan);
            }

            Map<String, Object> timing = new LinkedHashMap<>();
            timing.put("dbMs", dbElapsedMs);
            timing.put("downstreamMs", downstreamElapsedMs);
            timing.put("totalMs", nanosToMillis(totalStartedAt));

            Map<String, Object> pricing = new LinkedHashMap<>();
            pricing.put("tier", tier);
            pricing.put("source", "catalog-chain");
            pricing.put("downstreamFaultMode", normalizeDownstreamFault(downstreamFault));
            pricing.put("fanout", Math.max(1, fanout));

            Map<String, Object> response = new LinkedHashMap<>();
            response.put("faultMode", fault);
            response.put("downstreamFaultMode", normalizeDownstreamFault(downstreamFault));
            response.put("timing", timing);
            response.put("catalog", catalogResponse.bodyJson());
            response.put("pricing", pricing);
            response.put("orderSummary", Map.of(
                    "customerId", orderSummary.customerId(),
                    "customerEmail", customer.email(),
                    "customerTier", customer.loyaltyTier(),
                    "orderCount", orderSummary.orderCount(),
                    "totalSpent", orderSummary.totalSpent(),
                    "lastOrderAt", orderSummary.lastOrderAt(),
                    "queryLabel", orderSummary.queryLabel()
            ));
            return response;
        } catch (RuntimeException ex) {
            rootSpan.recordException(ex);
            rootSpan.setStatus(StatusCode.ERROR, ex.getClass().getSimpleName());
            log.error("checkout_preview_failed fault={} downstreamFault={} userId={}", fault, downstreamFault, userId, ex);
            throw ex;
        } finally {
            rootSpan.end();
        }
    }

    private CustomerRecord loadCustomer(long userId) {
        Span span = tracer.spanBuilder("order.query_customer").startSpan();
        try (Scope ignored = span.makeCurrent()) {
            CustomerRecord customer = repository.findCustomer(userId);
            if (customer == null) {
                throw new IllegalArgumentException("customer not found for userId=" + userId);
            }
            return customer;
        } catch (RuntimeException ex) {
            span.recordException(ex);
            span.setStatus(StatusCode.ERROR, ex.getMessage());
            throw ex;
        } finally {
            span.end();
        }
    }

    private OrderSummary loadSlowSummary(long userId) {
        Span span = tracer.spanBuilder("order.query_orders_slow").startSpan();
        try (Scope ignored = span.makeCurrent()) {
            span.setAttribute(QUERY_LABEL, "slowOrdersByCustomerCast");
            span.setAttribute(SQL_TEMPLATE, OrderLabRepository.SLOW_SUMMARY_SQL);
            log.info("sql_query_label=slowOrdersByCustomerCast userId={} sql={}", userId, singleLine(OrderLabRepository.SLOW_SUMMARY_SQL));
            return repository.loadSlowSummary(userId);
        } catch (RuntimeException ex) {
            span.recordException(ex);
            span.setStatus(StatusCode.ERROR, ex.getMessage());
            throw ex;
        } finally {
            span.end();
        }
    }

    private void triggerNullPointer(Span rootSpan) {
        Span span = tracer.spanBuilder("order.trigger_null_pointer").startSpan();
        try (Scope ignored = span.makeCurrent()) {
            rootSpan.setAttribute("fault.trigger", "null-pointer");
            log.error("null_pointer_fault_triggered stage=post-downstream");
            Map<String, Object> broken = null;
            broken.get("missing");
        } catch (RuntimeException ex) {
            span.recordException(ex);
            span.setStatus(StatusCode.ERROR, ex.getClass().getSimpleName());
            throw ex;
        } finally {
            span.end();
        }
    }

    private String normalizeDownstreamFault(String downstreamFault) {
        if (downstreamFault == null || downstreamFault.isBlank()) {
            return "none";
        }
        return downstreamFault;
    }

    private long nanosToMillis(long startedAt) {
        return (System.nanoTime() - startedAt) / 1_000_000L;
    }

    private String singleLine(String sql) {
        return sql.replace('\n', ' ').replaceAll("\\s+", " ").trim();
    }
}
