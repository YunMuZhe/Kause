#!/bin/zsh

exec /usr/local/bin/kubectl --context orbstack -n observability port-forward svc/signoz 3301:8080
