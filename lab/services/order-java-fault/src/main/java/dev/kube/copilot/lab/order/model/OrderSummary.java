package dev.kube.copilot.lab.order.model;

import java.math.BigDecimal;
import java.time.Instant;

public record OrderSummary(long customerId, long orderCount, BigDecimal totalSpent, Instant lastOrderAt, String queryLabel, String sqlTemplate) {
}
