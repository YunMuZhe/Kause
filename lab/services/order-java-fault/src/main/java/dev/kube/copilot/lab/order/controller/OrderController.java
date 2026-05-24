package dev.kube.copilot.lab.order.controller;

import dev.kube.copilot.lab.order.service.CheckoutPreviewService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

@RestController
@RequestMapping("/api/orders")
public class OrderController {

    private final CheckoutPreviewService checkoutPreviewService;

    public OrderController(CheckoutPreviewService checkoutPreviewService) {
        this.checkoutPreviewService = checkoutPreviewService;
    }

    @GetMapping("/checkout-preview")
    public Map<String, Object> checkoutPreview(
            @RequestParam(defaultValue = "none") String fault,
            @RequestParam(defaultValue = "none") String downstreamFault,
            @RequestParam(defaultValue = "1") int fanout,
            @RequestParam(defaultValue = "42") long userId,
            @RequestParam(defaultValue = "gold") String tier
    ) {
        return checkoutPreviewService.checkoutPreview(fault, downstreamFault, fanout, userId, tier);
    }
}
