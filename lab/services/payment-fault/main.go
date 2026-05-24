package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.37.0"
	"go.opentelemetry.io/otel/trace"
)

type serverConfig struct {
	port         string
	serviceName  string
	otelEndpoint string
	baseLatency  time.Duration
}

func main() {
	cfg := serverConfig{
		port:         envOrDefault("PORT", "8081"),
		serviceName:  envOrDefault("OTEL_SERVICE_NAME", "payment-fault"),
		otelEndpoint: envOrDefault("OTEL_EXPORTER_OTLP_ENDPOINT", "localhost:4317"),
		baseLatency:  durationEnv("BASE_LATENCY_MS", 60),
	}

	shutdownTelemetry, err := initTelemetry(context.Background(), cfg.serviceName, cfg.otelEndpoint)
	if err != nil {
		log.Fatalf("init telemetry: %v", err)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := shutdownTelemetry(ctx); err != nil {
			log.Printf("shutdown telemetry: %v", err)
		}
	}()

	mux := http.NewServeMux()
	mux.Handle("/healthz", otelhttp.NewHandler(http.HandlerFunc(handleHealth), "healthz"))
	mux.Handle("/readyz", otelhttp.NewHandler(http.HandlerFunc(handleReady), "readyz"))
	mux.Handle("/internal/pricing", otelhttp.NewHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handlePricing(w, r, cfg)
	}), "payment.pricing"))
	mux.Handle("/api/payments/charge", otelhttp.NewHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handleCharge(w, r, cfg)
	}), "payment.charge"))

	srv := &http.Server{
		Addr:              ":" + cfg.port,
		Handler:           requestLogger(mux),
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		log.Printf("payment-fault listening on %s", srv.Addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("server failed: %v", err)
		}
	}()

	waitForShutdown(srv)
}

func handleHealth(w http.ResponseWriter, _ *http.Request) {
	respondJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func handleReady(w http.ResponseWriter, _ *http.Request) {
	respondJSON(w, http.StatusOK, map[string]string{"status": "ready"})
}

func handlePricing(w http.ResponseWriter, r *http.Request, cfg serverConfig) {
	ctx, span := otel.Tracer(cfg.serviceName).Start(r.Context(), "payment.load_pricing")
	defer span.End()

	simulateLatency(ctx, cfg.baseLatency)

	faultMode := requestString(r, "fault", envOrDefault("FAULT_MODE", "none"))
	tier := requestString(r, "tier", "gold")
	span.SetAttributes(attribute.String("fault.mode", faultMode), attribute.String("pricing.tier", tier))

	if faultMode == "db-timeout" {
		err := simulateDatabaseTimeout(ctx)
		recordAppError(span, err, "database timeout while loading pricing rules")
		http.Error(w, fmt.Sprintf("database timeout while loading pricing rules: %v", err), http.StatusInternalServerError)
		return
	}

	if faultMode == "cache-stampede" {
		time.Sleep(350 * time.Millisecond)
	}

	respondJSON(w, http.StatusOK, map[string]any{
		"tier":     tier,
		"discount": 0.95,
	})
}

func handleCharge(w http.ResponseWriter, r *http.Request, cfg serverConfig) {
	ctx, span := otel.Tracer(cfg.serviceName).Start(r.Context(), "payment.charge_card")
	defer span.End()

	simulateLatency(ctx, cfg.baseLatency)
	respondJSON(w, http.StatusAccepted, map[string]any{
		"status": "accepted",
		"id":     "pay_local_001",
	})
}

func simulateDatabaseTimeout(ctx context.Context) error {
	ctx, span := otel.Tracer("payment-fault").Start(ctx, "payment.query_database")
	defer span.End()

	dbHost := envOrDefault("DB_HOST", "postgres.observability.svc.cluster.local")
	dbName := envOrDefault("DB_NAME", "payments")
	span.SetAttributes(attribute.String("db.system", "postgresql"), attribute.String("db.namespace", dbName), attribute.String("server.address", dbHost))

	deadline := durationEnv("DB_TIMEOUT_MS", 1600)
	timer := time.NewTimer(deadline)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		err := ctx.Err()
		recordAppError(span, err, "request context cancelled")
		return err
	case <-timer.C:
		return fmt.Errorf("dial tcp %s:5432: i/o timeout", dbHost)
	}
}

func requestLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		log.Printf("method=%s path=%s remote=%s duration_ms=%d", r.Method, r.URL.Path, r.RemoteAddr, time.Since(start).Milliseconds())
	})
}

func respondJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func simulateLatency(ctx context.Context, d time.Duration) {
	if d <= 0 {
		return
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
	case <-timer.C:
	}
}

func recordAppError(span trace.Span, err error, msg string) {
	span.RecordError(err)
	span.SetAttributes(attribute.String("error.message", msg))
}

func initTelemetry(ctx context.Context, serviceName, endpoint string) (func(context.Context) error, error) {
	exp, err := otlptracegrpc.New(ctx,
		otlptracegrpc.WithEndpoint(endpoint),
		otlptracegrpc.WithInsecure(),
	)
	if err != nil {
		return nil, err
	}

	res, err := resource.New(ctx,
		resource.WithAttributes(
			semconv.ServiceName(serviceName),
			attribute.String("deployment.environment", envOrDefault("DEPLOYMENT_ENVIRONMENT", "local-lab")),
		),
	)
	if err != nil {
		return nil, err
	}

	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exp),
		sdktrace.WithResource(res),
	)

	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(propagation.TraceContext{})
	return tp.Shutdown, nil
}

func waitForShutdown(srv *http.Server) {
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		log.Printf("graceful shutdown failed: %v", err)
	}
}

func envOrDefault(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

func durationEnv(key string, fallbackMs int) time.Duration {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return time.Duration(fallbackMs) * time.Millisecond
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return time.Duration(fallbackMs) * time.Millisecond
	}
	return time.Duration(value) * time.Millisecond
}

func requestString(r *http.Request, key, fallback string) string {
	if value := strings.TrimSpace(r.URL.Query().Get(key)); value != "" {
		return value
	}
	return fallback
}
