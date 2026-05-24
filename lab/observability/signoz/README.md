# SigNoz on Kubernetes

This directory contains the local-cluster installation assets for SigNoz.

## Files

- `values.yaml`: Helm overrides for a local OrbStack cluster
- `otel-collector-service.yaml`: stable in-cluster alias so apps can send OTLP to `otel-collector.observability.svc.cluster.local:4317`

## Install

```bash
helm repo add signoz https://charts.signoz.io
helm repo update
helm upgrade --install signoz signoz/signoz \
  --namespace observability \
  --create-namespace \
  -f ./lab/observability/signoz/values.yaml \
  --wait \
  --timeout 30m

kubectl apply -f ./lab/observability/signoz/otel-collector-service.yaml
```

## Access UI

```bash
kubectl -n observability port-forward svc/signoz 3301:8080
```

Then open `http://localhost:3301`.

For a stable local browser entry on this Mac, use:

```bash
./lab/observability/signoz/port-forward-signoz.sh
```
