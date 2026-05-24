# Kause Lab

This lab now includes two Go services, one Spring Boot service, and an in-cluster MySQL dataset for validating K8S + trace + SQL driven incident investigation.

## Services

- `catalog-fault`: front-door service that calls `payment-fault`
- `payment-fault`: dependency service that can simulate database timeout and slow-path behavior
- `order-java-fault`: Spring Boot front-door that queries MySQL and then calls `catalog-fault`
- `lab-mysql`: in-cluster MySQL with `customers`, `orders`, `order_items`

Both services emit OpenTelemetry traces to `otel-collector.observability.svc.cluster.local:4317`.

That endpoint assumes your OTEL Collector is running inside Kubernetes in namespace `observability`.
For your setup, that is the recommended path because the pods can report to a stable in-cluster DNS name.

## Fault Scenarios

1. `slow-sql`
   - `order-java-fault` runs a bad query template `slowOrdersByCustomerCast`
   - expected symptoms:
     - Java endpoint still returns 200
     - traces contain `db.query.label` and `db.query.template`
     - `EXPLAIN` shows an inefficient scan plan

2. `null-pointer`
   - `order-java-fault` first completes the downstream call, then throws `NullPointerException`
   - expected symptoms:
     - Java endpoint returns 500
     - logs contain NPE stack trace
     - traces include exception spans

3. `db-timeout`
   - `payment-fault` returns HTTP 500 with a simulated database timeout
   - expected symptoms:
     - `catalog-fault` or `order-java-fault` returns 503
     - `payment-fault` logs contain `database timeout while loading pricing rules`
     - traces show `payment.query_database`

4. `cache-stampede`
   - `catalog-fault` bypasses cache and repeatedly calls `payment-fault`
   - `payment-fault` becomes slow but still succeeds
   - expected symptoms:
     - elevated latency on `catalog-fault`
     - trace fan-out through `catalog.query_pricing`

## Build images

For OrbStack Kubernetes, build the images into the `orbstack` Docker context so the cluster can see them:

```bash
docker context use orbstack
docker build -t kube-cluster-copilot/catalog-fault:latest ./lab/services/catalog-fault
docker build -t kube-cluster-copilot/payment-fault:latest ./lab/services/payment-fault
docker build -t kube-cluster-copilot/order-java-fault:latest ./lab/services/order-java-fault
```

If you do not want to change the global context, use:

```bash
docker --context orbstack build -t kube-cluster-copilot/catalog-fault:latest ./lab/services/catalog-fault
docker --context orbstack build -t kube-cluster-copilot/payment-fault:latest ./lab/services/payment-fault
docker --context orbstack build -t kube-cluster-copilot/order-java-fault:latest ./lab/services/order-java-fault
```

## Deploy base

```bash
kubectl apply -k ./lab/deployments/k8s/base
```

## Overlay compatibility mode

```bash
kubectl apply -k ./lab/deployments/k8s/overlays/db-timeout
kubectl apply -k ./lab/deployments/k8s/overlays/cache-stampede
```

The overlays still work, but the main Lab 2.0 path is request-driven fault injection.

## Trigger traffic directly by request parameters

```bash
kubectl -n kube-copilot-lab exec deploy/order-java-fault -- sh -lc 'curl -sS "http://order-java-fault:8082/api/orders/checkout-preview?fault=slow-sql&downstreamFault=none&fanout=1&userId=42&tier=gold"'
kubectl -n kube-copilot-lab exec deploy/order-java-fault -- sh -lc 'curl -sS "http://order-java-fault:8082/api/orders/checkout-preview?fault=null-pointer&downstreamFault=none&fanout=1&userId=42&tier=gold"'
kubectl -n kube-copilot-lab exec deploy/order-java-fault -- sh -lc 'curl -sS "http://order-java-fault:8082/api/orders/checkout-preview?fault=none&downstreamFault=db-timeout&fanout=1&userId=42&tier=gold"'
kubectl -n kube-copilot-lab exec deploy/catalog-fault -- sh -lc 'curl -sS "http://catalog-fault:8080/api/catalog/items?fault=cache-stampede&fanout=5&tier=gold"'
```

## Suggested test flow

Base deployment:

```bash
kubectl apply -k ./lab/deployments/k8s/base
kubectl -n kube-copilot-lab rollout status deploy/lab-mysql
kubectl -n kube-copilot-lab rollout status deploy/catalog-fault
kubectl -n kube-copilot-lab rollout status deploy/payment-fault
kubectl -n kube-copilot-lab rollout status deploy/order-java-fault
```

Images now include `curl`, so you can debug directly from the service containers:

```bash
kubectl -n kube-copilot-lab exec deploy/catalog-fault -- sh
kubectl -n kube-copilot-lab exec deploy/payment-fault -- sh
kubectl -n kube-copilot-lab exec deploy/order-java-fault -- sh
```

Then use either:

- the React Lab page from the main `apps/frontend + apps/backend` stack, or
- the legacy Qwen-Agent integration in `lab/legacy/qwen-agent`.

## SigNoz placement

For your case, yes: running OTEL Collector and the SigNoz ingest path in Kubernetes is the cleanest choice.

- Current manifests already point to `otel-collector.observability.svc.cluster.local:4317`.
- Pods can always resolve that service name.
- You avoid host-network routing issues between OrbStack Kubernetes and Docker containers on macOS.

If SigNoz stays in Docker, it can still work, but you need an endpoint reachable from the cluster and you will have to change the `OTEL_EXPORTER_OTLP_ENDPOINT` values in the two ConfigMaps.
