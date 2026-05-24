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
	port              string
	serviceName       string
	otelEndpoint      string
	baseLatency       time.Duration
	dependencyBaseURL string
}

type item struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Inventory int     `json:"inventory"`
	Price     float64 `json:"price"`
}

func main() {
	cfg := serverConfig{
		port:              envOrDefault("PORT", "8080"),
		serviceName:       envOrDefault("OTEL_SERVICE_NAME", "catalog-fault"),
		otelEndpoint:      envOrDefault("OTEL_EXPORTER_OTLP_ENDPOINT", "localhost:4317"),
		baseLatency:       durationEnv("BASE_LATENCY_MS", 40),
		dependencyBaseURL: strings.TrimRight(envOrDefault("DEPENDENCY_BASE_URL", "http://payment-fault:8081"), "/"),
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
	mux.Handle("/api/catalog/items", otelhttp.NewHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handleItems(w, r, cfg)
	}), "catalog.items"))
	mux.Handle("/api/catalog/cache-refresh", otelhttp.NewHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handleRefresh(w, r, cfg)
	}), "catalog.cache_refresh"))

	srv := &http.Server{
		Addr:              ":" + cfg.port,
		Handler:           requestLogger(mux),
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		log.Printf("catalog-fault listening on %s", srv.Addr)
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

func handleItems(w http.ResponseWriter, r *http.Request, cfg serverConfig) {
	ctx, span := otel.Tracer(cfg.serviceName).Start(r.Context(), "catalog.load_items")
	defer span.End()

	simulateLatency(ctx, cfg.baseLatency)

	faultMode := requestString(r, "fault", envOrDefault("FAULT_MODE", "none"))
	userTier := requestString(r, "tier", envOrDefault("USER_TIER", "gold"))
	fanout := requestInt(r, "fanout", 1)
	if fanout < 1 {
		fanout = 1
	}
	span.SetAttributes(
		attribute.String("fault.mode", faultMode),
		attribute.String("user.tier", userTier),
		attribute.Int("fault.fanout", fanout),
	)

	items := []item{
		{ID: "sku-payment-core", Name: "Payment Core", Inventory: 12, Price: 129.90},
		{ID: "sku-ledger-pro", Name: "Ledger Pro", Inventory: 3, Price: 389.00},
	}

	if requiresPricingDependency(faultMode) {
		for attempt := 0; attempt < dependencyCalls(faultMode, fanout); attempt++ {
			if err := queryPricingDependency(ctx, cfg.dependencyBaseURL, userTier, faultMode); err != nil {
				recordAppError(span, err, "pricing dependency failed")
				http.Error(w, fmt.Sprintf("pricing dependency failed: %v", err), http.StatusServiceUnavailable)
				return
			}
		}
	}

	respondJSON(w, http.StatusOK, map[string]any{
		"items":      items,
		"fault_mode": faultMode,
		"fanout":     dependencyCalls(faultMode, fanout),
		"cached":     faultMode == "none",
	})
}

func handleRefresh(w http.ResponseWriter, r *http.Request, cfg serverConfig) {
	ctx, span := otel.Tracer(cfg.serviceName).Start(r.Context(), "catalog.refresh_cache")
	defer span.End()

	simulateLatency(ctx, cfg.baseLatency/2)
	respondJSON(w, http.StatusAccepted, map[string]any{
		"status":       "refresh triggered",
		"service_name": cfg.serviceName,
	})
}

func queryPricingDependency(ctx context.Context, baseURL, tier, faultMode string) error {
	ctx, span := otel.Tracer("catalog-fault").Start(ctx, "catalog.query_pricing")
	defer span.End()

	span.SetAttributes(
		attribute.String("fault.mode", faultMode),
		attribute.String("pricing.tier", tier),
	)

	targetURL := fmt.Sprintf("%s/internal/pricing?tier=%s&fault=%s", baseURL, tier, faultMode)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, targetURL, nil)
	if err != nil {
		recordAppError(span, err, "build dependency request")
		return err
	}

	client := http.Client{
		Timeout:   2 * time.Second,
		Transport: otelhttp.NewTransport(http.DefaultTransport),
	}

	resp, err := client.Do(req)
	if err != nil {
		recordAppError(span, err, "dependency request failed")
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 500 {
		err = fmt.Errorf("dependency returned status %d", resp.StatusCode)
		recordAppError(span, err, "dependency response failure")
		return err
	}
	return nil
}

func requiresPricingDependency(faultMode string) bool {
	switch faultMode {
	case "cache-stampede", "db-timeout":
		return true
	default:
		return false
	}
}

func dependencyCalls(faultMode string, fanout int) int {
	if faultMode == "cache-stampede" {
		return fanout
	}
	if requiresPricingDependency(faultMode) {
		return 1
	}
	return 0
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

func requestInt(r *http.Request, key string, fallback int) int {
	raw := strings.TrimSpace(r.URL.Query().Get(key))
	if raw == "" {
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	return value
}
