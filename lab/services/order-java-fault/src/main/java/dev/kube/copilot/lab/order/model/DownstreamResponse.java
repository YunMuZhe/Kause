package dev.kube.copilot.lab.order.model;

import java.util.Map;

public record DownstreamResponse(int statusCode, String bodyText, Map<String, Object> bodyJson) {
}
