package dev.kube.copilot.lab.order.config;

import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.api.OpenTelemetry;
import io.opentelemetry.api.trace.Tracer;
import io.opentelemetry.context.propagation.ContextPropagators;
import io.opentelemetry.exporter.otlp.trace.OtlpGrpcSpanExporter;
import io.opentelemetry.sdk.OpenTelemetrySdk;
import io.opentelemetry.sdk.resources.Resource;
import io.opentelemetry.sdk.trace.SdkTracerProvider;
import io.opentelemetry.sdk.trace.export.BatchSpanProcessor;
import io.opentelemetry.api.common.Attributes;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.time.Duration;

@Configuration
public class TelemetryConfig {

    @Bean(destroyMethod = "close")
    public OpenTelemetrySdk openTelemetry(
            @Value("${OTEL_EXPORTER_OTLP_ENDPOINT:otel-collector.observability.svc.cluster.local:4317}") String endpoint,
            @Value("${OTEL_SERVICE_NAME:order-java-fault}") String serviceName,
            @Value("${DEPLOYMENT_ENVIRONMENT:lab}") String environment
    ) {
        OtlpGrpcSpanExporter exporter = OtlpGrpcSpanExporter.builder()
                .setEndpoint("http://" + endpoint)
                .setTimeout(Duration.ofSeconds(5))
                .build();

        Resource resource = Resource.getDefault().merge(Resource.create(Attributes.of(
                io.opentelemetry.api.common.AttributeKey.stringKey("service.name"), serviceName,
                io.opentelemetry.api.common.AttributeKey.stringKey("deployment.environment"), environment
        )));

        SdkTracerProvider tracerProvider = SdkTracerProvider.builder()
                .setResource(resource)
                .addSpanProcessor(BatchSpanProcessor.builder(exporter).build())
                .build();

        OpenTelemetrySdk sdk = OpenTelemetrySdk.builder()
                .setTracerProvider(tracerProvider)
                .setPropagators(ContextPropagators.create(io.opentelemetry.api.trace.propagation.W3CTraceContextPropagator.getInstance()))
                .build();

        GlobalOpenTelemetry.resetForTest();
        GlobalOpenTelemetry.set(sdk);
        return sdk;
    }

    @Bean
    public Tracer tracer(OpenTelemetry openTelemetry, @Value("${OTEL_SERVICE_NAME:order-java-fault}") String serviceName) {
        return openTelemetry.getTracer(serviceName);
    }
}
