package dev.kube.copilot.lab.order.repository;

import dev.kube.copilot.lab.order.model.CustomerRecord;
import dev.kube.copilot.lab.order.model.OrderSummary;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.util.Map;

@Repository
public class OrderLabRepository {

    public static final String FAST_SUMMARY_SQL = """
            SELECT
              customer_id,
              COUNT(*) AS order_count,
              COALESCE(SUM(total_amount), 0) AS total_spent,
              MAX(created_at) AS last_order_at
            FROM orders
            WHERE customer_id = ?
            GROUP BY customer_id
            """;

    public static final String SLOW_SUMMARY_SQL = """
            SELECT
              o.customer_id,
              COUNT(DISTINCT o.id) AS order_count,
              COALESCE(SUM(oi.quantity * oi.unit_price), 0) AS total_spent,
              MAX(o.created_at) AS last_order_at
            FROM orders o
            JOIN order_items oi ON oi.order_id = o.id
            WHERE CAST(o.customer_id AS CHAR) = ?
            GROUP BY o.customer_id
            ORDER BY last_order_at DESC
            """;

    private final JdbcTemplate jdbcTemplate;

    public OrderLabRepository(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    public CustomerRecord findCustomer(long userId) {
        try {
            return jdbcTemplate.queryForObject(
                    "SELECT id, email, full_name, loyalty_tier FROM customers WHERE id = ?",
                    (rs, rowNum) -> new CustomerRecord(
                            rs.getLong("id"),
                            rs.getString("email"),
                            rs.getString("full_name"),
                            rs.getString("loyalty_tier")
                    ),
                    userId
            );
        } catch (EmptyResultDataAccessException ex) {
            return null;
        }
    }

    public OrderSummary loadFastSummary(long userId) {
        return toSummary(userId, "fastOrdersByCustomer", FAST_SUMMARY_SQL, jdbcTemplate.queryForMap(FAST_SUMMARY_SQL, userId));
    }

    public OrderSummary loadSlowSummary(long userId) {
        return toSummary(userId, "slowOrdersByCustomerCast", SLOW_SUMMARY_SQL, jdbcTemplate.queryForMap(SLOW_SUMMARY_SQL, Long.toString(userId)));
    }

    private OrderSummary toSummary(long userId, String queryLabel, String sqlTemplate, Map<String, Object> row) {
        Instant lastOrderAt = toInstant(row.get("last_order_at"));
        return new OrderSummary(
                userId,
                ((Number) row.get("order_count")).longValue(),
                (BigDecimal) row.get("total_spent"),
                lastOrderAt,
                queryLabel,
                sqlTemplate
        );
    }

    private Instant toInstant(Object value) {
        if (value == null) {
            return null;
        }
        if (value instanceof Timestamp timestamp) {
            return timestamp.toInstant();
        }
        if (value instanceof LocalDateTime localDateTime) {
            return localDateTime.toInstant(ZoneOffset.UTC);
        }
        if (value instanceof Instant instant) {
            return instant;
        }
        throw new IllegalStateException("Unsupported timestamp type: " + value.getClass().getName());
    }
}
