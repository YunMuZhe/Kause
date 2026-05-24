package dev.kube.copilot.lab.order.service;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.kube.copilot.lab.order.model.DownstreamResponse;
import io.opentelemetry.api.OpenTelemetry;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.Scope;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.util.UriComponentsBuilder;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;

@Component
public class DownstreamCatalogClient {

    private final HttpClient httpClient;
    private final ObjectMapper objectMapper;
    private final OpenTelemetry openTelemetry;
    private final String catalogBaseUrl;

    public DownstreamCatalogClient(
            ObjectMapper objectMapper,
            OpenTelemetry openTelemetry,
            @Value("${CATALOG_BASE_URL:http://catalog-fault:8080}") String catalogBaseUrl
    ) {
        this.httpClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build();
        this.objectMapper = objectMapper;
        this.openTelemetry = openTelemetry;
        this.catalogBaseUrl = catalogBaseUrl;
    }

    public DownstreamResponse fetchCatalog(String downstreamFault, int fanout, String tier) {
        URI uri = UriComponentsBuilder.fromUriString(catalogBaseUrl)
                .path("/api/catalog/items")
                .queryParam("fault", downstreamFault)
                .queryParam("fanout", fanout)
                .queryParam("tier", tier)
                .build(true)
                .toUri();

        HttpRequest.Builder builder = HttpRequest.newBuilder(uri)
                .GET()
                .timeout(Duration.ofSeconds(15));

        Context currentContext = Context.current();
        try (Scope ignored = currentContext.makeCurrent()) {
            openTelemetry.getPropagators().getTextMapPropagator()
                    .inject(currentContext, builder, (carrier, key, value) -> carrier.header(key, value));
        }

        try {
            HttpResponse<String> response = httpClient.send(builder.build(), HttpResponse.BodyHandlers.ofString());
            return new DownstreamResponse(
                    response.statusCode(),
                    response.body(),
                    parseJson(response.body())
            );
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("catalog-fault call interrupted", ex);
        } catch (IOException ex) {
            throw new IllegalStateException("catalog-fault call failed", ex);
        }
    }

    private Map<String, Object> parseJson(String body) {
        if (body == null || body.isBlank()) {
            return Map.of();
        }
        try {
            return objectMapper.readValue(body, new TypeReference<>() {
            });
        } catch (Exception ex) {
            Map<String, Object> fallback = new LinkedHashMap<>();
            fallback.put("raw", body);
            return fallback;
        }
    }
}
