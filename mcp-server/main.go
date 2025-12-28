package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
	v1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/clientcmd"
	"k8s.io/client-go/util/homedir"
)

func main() {
	// Initialize Kubernetes client
	kubeconfig := os.Getenv("KUBECONFIG")
	if kubeconfig == "" {
		if home := homedir.HomeDir(); home != "" {
			kubeconfig = filepath.Join(home, ".kube", "config")
		}
	}

	config, err := clientcmd.BuildConfigFromFlags("", kubeconfig)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error building kubeconfig: %v\n", err)
		os.Exit(1)
	}

	clientset, err := kubernetes.NewForConfig(config)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error creating kubernetes client: %v\n", err)
		os.Exit(1)
	}

	// Create MCP server
	s := server.NewMCPServer(
		"Kube-Cluster-Copilot-MCP",
		"1.0.0",
		server.WithLogging(),
	)

	// Register get_deployment_status tool
	s.AddTool(mcp.NewTool("get_deployment_status",
		mcp.WithDescription("Get status, events and logs of a Kubernetes Deployment"),
		mcp.WithString("namespace", mcp.Required(), mcp.Description("The namespace of the deployment")),
		mcp.WithString("deployment_name", mcp.Required(), mcp.Description("The name of the deployment")),
	), getDeploymentStatusHandler(clientset))

	// Register get_ingresses tool
	s.AddTool(mcp.NewTool("get_ingresses",
		mcp.WithDescription("List all Ingress resources in a namespace with their rules and backend status"),
		mcp.WithString("namespace", mcp.Required(), mcp.Description("The namespace to list Ingresses from")),
	), getIngressesHandler(clientset))

	// Register get_pod_logs tool
	s.AddTool(mcp.NewTool("get_pod_logs",
		mcp.WithDescription("Get logs of a specific pod"),
		mcp.WithString("namespace", mcp.Required(), mcp.Description("The namespace of the pod")),
		mcp.WithString("pod_name", mcp.Required(), mcp.Description("The name of the pod")),
		mcp.WithString("container_name", mcp.Description("The name of the container (optional)")),
		mcp.WithNumber("tail_lines", mcp.Description("Number of tail lines to get (default 50)")),
	), getPodLogsHandler(clientset))

	// Register list_events tool
	s.AddTool(mcp.NewTool("list_events",
		mcp.WithDescription("List events in a namespace, optionally filtered by an entity name"),
		mcp.WithString("namespace", mcp.Required(), mcp.Description("The namespace to list events from")),
		mcp.WithString("entity_name", mcp.Description("Filter events by involved object name (optional)")),
	), listEventsHandler(clientset))

	// Register get_service_details tool
	s.AddTool(mcp.NewTool("get_service_details",
		mcp.WithDescription("Get details of a Kubernetes Service (spec, ports, selector)"),
		mcp.WithString("namespace", mcp.Required(), mcp.Description("The namespace of the service")),
		mcp.WithString("service_name", mcp.Required(), mcp.Description("The name of the service")),
	), getServiceDetailsHandler(clientset))

	// Register get_endpoints tool
	s.AddTool(mcp.NewTool("get_endpoints",
		mcp.WithDescription("Get endpoints (IP addresses) associated with a Service"),
		mcp.WithString("namespace", mcp.Required(), mcp.Description("The namespace of the service")),
		mcp.WithString("service_name", mcp.Required(), mcp.Description("The name of the service")),
	), getEndpointsHandler(clientset))

	// Register list_pods tool
	s.AddTool(mcp.NewTool("list_pods",
		mcp.WithDescription("List all Pods in a namespace with their status"),
		mcp.WithString("namespace", mcp.Required(), mcp.Description("The namespace to list Pods from")),
	), listPodsHandler(clientset))

	// Register list_deployments tool
	s.AddTool(mcp.NewTool("list_deployments",
		mcp.WithDescription("List all Deployments in a namespace with their status"),
		mcp.WithString("namespace", mcp.Required(), mcp.Description("The namespace to list Deployments from")),
	), listDeploymentsHandler(clientset))

	// Register list_namespaces tool
	s.AddTool(mcp.NewTool("list_namespaces",
		mcp.WithDescription("List all namespaces in the Kubernetes cluster"),
	), listNamespacesHandler(clientset))

	// Run the server using stdio
	if err := server.ServeStdio(s); err != nil {
		fmt.Fprintf(os.Stderr, "Error serving mcp: %v\n", err)
		os.Exit(1)
	}
}

func getDeploymentStatusHandler(clientset *kubernetes.Clientset) func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	return func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		namespace, err := request.RequireString("namespace")
		if err != nil {
			return nil, err
		}
		name, err := request.RequireString("deployment_name")
		if err != nil {
			return nil, err
		}

		// 1. Get Deployment
		deploy, err := clientset.AppsV1().Deployments(namespace).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("Failed to get deployment: %v", err)), nil
		}

		status := map[string]interface{}{
			"name":      deploy.Name,
			"namespace": deploy.Namespace,
			"replicas": map[string]int32{
				"desired":   *deploy.Spec.Replicas,
				"current":   deploy.Status.Replicas,
				"updated":   deploy.Status.UpdatedReplicas,
				"ready":     deploy.Status.ReadyReplicas,
				"available": deploy.Status.AvailableReplicas,
			},
			"conditions": deploy.Status.Conditions,
		}

		// 2. Get Pods
		selector := metav1.FormatLabelSelector(deploy.Spec.Selector)
		pods, err := clientset.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{LabelSelector: selector})
		if err == nil {
			podInfos := []map[string]interface{}{}
			for _, pod := range pods.Items {
				podInfo := map[string]interface{}{
					"name":   pod.Name,
					"status": pod.Status.Phase,
					"reason": pod.Status.Reason,
				}

				// Check containers status
				containerStatuses := []map[string]interface{}{}
				for _, cs := range pod.Status.ContainerStatuses {
					containerStatuses = append(containerStatuses, map[string]interface{}{
						"name":         cs.Name,
						"ready":        cs.Ready,
						"restartCount": cs.RestartCount,
						"state":        cs.State,
					})
				}
				podInfo["containerStatuses"] = containerStatuses

				// 3. Get Events for each Pod
				events, _ := clientset.CoreV1().Events(namespace).List(ctx, metav1.ListOptions{
					FieldSelector: fmt.Sprintf("involvedObject.name=%s,involvedObject.kind=Pod", pod.Name),
				})
				eventList := []string{}
				if events != nil {
					for _, e := range events.Items {
						eventList = append(eventList, fmt.Sprintf("[%s] %s: %s", e.LastTimestamp, e.Reason, e.Message))
					}
				}
				podInfo["events"] = eventList

				// 4. Get Logs if pod is not healthy
				if pod.Status.Phase != v1.PodRunning || hasProblem(pod) {
					logContent := getPodLogs(ctx, clientset, pod.Namespace, pod.Name)
					podInfo["logs"] = logContent
				}

				podInfos = append(podInfos, podInfo)
			}
			status["pods"] = podInfos
		}

		resultJSON, _ := json.MarshalIndent(status, "", "  ")
		return mcp.NewToolResultText(string(resultJSON)), nil
	}
}

func hasProblem(pod v1.Pod) bool {
	for _, cs := range pod.Status.ContainerStatuses {
		if cs.RestartCount > 0 || !cs.Ready {
			return true
		}
	}
	return false
}

func getPodLogs(ctx context.Context, clientset *kubernetes.Clientset, namespace, podName string) string {
	pod, err := clientset.CoreV1().Pods(namespace).Get(ctx, podName, metav1.GetOptions{})
	if err != nil || len(pod.Spec.Containers) == 0 {
		return ""
	}

	containerName := pod.Spec.Containers[0].Name
	tailLines := int64(20)
	req := clientset.CoreV1().Pods(namespace).GetLogs(podName, &v1.PodLogOptions{
		Container: containerName,
		TailLines: &tailLines,
	})
	logs, err := req.DoRaw(ctx)
	if err != nil {
		return fmt.Sprintf("error getting logs: %v", err)
	}
	return string(logs)
}

func getIngressesHandler(clientset *kubernetes.Clientset) func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	return func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		namespace, err := request.RequireString("namespace")
		if err != nil {
			return nil, err
		}

		ingresses, err := clientset.NetworkingV1().Ingresses(namespace).List(ctx, metav1.ListOptions{})
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("Failed to list ingresses: %v", err)), nil
		}

		ingressList := []map[string]interface{}{}
		for _, ing := range ingresses.Items {
			ingInfo := map[string]interface{}{
				"name":              ing.Name,
				"namespace":         ing.Namespace,
				"ingressClassName":  ing.Spec.IngressClassName,
				"annotations":       ing.Annotations,
				"creationTimestamp": ing.CreationTimestamp,
			}

			rules := []map[string]interface{}{}
			for _, rule := range ing.Spec.Rules {
				ruleInfo := map[string]interface{}{
					"host": rule.Host,
				}
				paths := []map[string]interface{}{}
				if rule.HTTP != nil {
					for _, p := range rule.HTTP.Paths {
						pathInfo := map[string]interface{}{
							"path":     p.Path,
							"pathType": p.PathType,
							"backend":  p.Backend.Service.Name,
							"port":     p.Backend.Service.Port.Number,
						}

						// Check backend service and endpoints
						svc, svcErr := clientset.CoreV1().Services(namespace).Get(ctx, p.Backend.Service.Name, metav1.GetOptions{})
						if svcErr == nil {
							pathInfo["serviceFound"] = true
							pathInfo["serviceType"] = svc.Spec.Type

							endpoints, epErr := clientset.CoreV1().Endpoints(namespace).Get(ctx, p.Backend.Service.Name, metav1.GetOptions{})
							if epErr == nil {
								readyCount := 0
								for _, subset := range endpoints.Subsets {
									readyCount += len(subset.Addresses)
								}
								pathInfo["readyEndpoints"] = readyCount
							} else {
								pathInfo["readyEndpoints"] = 0
							}
						} else {
							pathInfo["serviceFound"] = false
						}

						paths = append(paths, pathInfo)
					}
				}
				ruleInfo["paths"] = paths
				rules = append(rules, ruleInfo)
			}
			ingInfo["rules"] = rules
			ingressList = append(ingressList, ingInfo)
		}

		resultJSON, _ := json.MarshalIndent(ingressList, "", "  ")
		return mcp.NewToolResultText(string(resultJSON)), nil
	}
}

func getPodLogsHandler(clientset *kubernetes.Clientset) func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	return func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		namespace, err := request.RequireString("namespace")
		if err != nil {
			return nil, err
		}
		podName, err := request.RequireString("pod_name")
		if err != nil {
			return nil, err
		}

		containerName := ""
		if args, ok := request.Params.Arguments.(map[string]interface{}); ok {
			if val, ok := args["container_name"]; ok {
				containerName = fmt.Sprintf("%v", val)
			}
		}

		tailLines := int64(50)
		if args, ok := request.Params.Arguments.(map[string]interface{}); ok {
			if val, ok := args["tail_lines"]; ok {
				if f, ok := val.(float64); ok {
					tailLines = int64(f)
				}
			}
		}

		// If container name is not specified, get the first one
		if containerName == "" {
			pod, err := clientset.CoreV1().Pods(namespace).Get(ctx, podName, metav1.GetOptions{})
			if err != nil {
				return mcp.NewToolResultError(fmt.Sprintf("Failed to get pod: %v", err)), nil
			}
			if len(pod.Spec.Containers) == 0 {
				return mcp.NewToolResultError("Pod has no containers"), nil
			}
			containerName = pod.Spec.Containers[0].Name
		}

		req := clientset.CoreV1().Pods(namespace).GetLogs(podName, &v1.PodLogOptions{
			Container: containerName,
			TailLines: &tailLines,
		})
		logs, err := req.DoRaw(ctx)
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("Error getting logs: %v", err)), nil
		}

		return mcp.NewToolResultText(string(logs)), nil
	}
}

func listEventsHandler(clientset *kubernetes.Clientset) func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	return func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		namespace, err := request.RequireString("namespace")
		if err != nil {
			return nil, err
		}

		opts := metav1.ListOptions{}
		if args, ok := request.Params.Arguments.(map[string]interface{}); ok {
			if entityName, ok := args["entity_name"]; ok && entityName != "" {
				opts.FieldSelector = fmt.Sprintf("involvedObject.name=%s", entityName)
			}
		}

		events, err := clientset.CoreV1().Events(namespace).List(ctx, opts)
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("Failed to list events: %v", err)), nil
		}

		eventInfos := []map[string]interface{}{}
		for _, e := range events.Items {
			eventInfos = append(eventInfos, map[string]interface{}{
				"lastTimestamp": e.LastTimestamp,
				"type":          e.Type,
				"reason":        e.Reason,
				"object":        fmt.Sprintf("%s/%s", e.InvolvedObject.Kind, e.InvolvedObject.Name),
				"message":       e.Message,
			})
		}

		resultJSON, _ := json.MarshalIndent(eventInfos, "", "  ")
		return mcp.NewToolResultText(string(resultJSON)), nil
	}
}

func getServiceDetailsHandler(clientset *kubernetes.Clientset) func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	return func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		namespace, err := request.RequireString("namespace")
		if err != nil {
			return nil, err
		}
		serviceName, err := request.RequireString("service_name")
		if err != nil {
			return nil, err
		}

		svc, err := clientset.CoreV1().Services(namespace).Get(ctx, serviceName, metav1.GetOptions{})
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("Failed to get service: %v", err)), nil
		}

		details := map[string]interface{}{
			"name":      svc.Name,
			"namespace": svc.Namespace,
			"type":      svc.Spec.Type,
			"selector":  svc.Spec.Selector,
			"ports":     svc.Spec.Ports,
			"clusterIP": svc.Spec.ClusterIP,
		}

		resultJSON, _ := json.MarshalIndent(details, "", "  ")
		return mcp.NewToolResultText(string(resultJSON)), nil
	}
}

func getEndpointsHandler(clientset *kubernetes.Clientset) func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	return func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		namespace, err := request.RequireString("namespace")
		if err != nil {
			return nil, err
		}
		serviceName, err := request.RequireString("service_name")
		if err != nil {
			return nil, err
		}

		endpoints, err := clientset.CoreV1().Endpoints(namespace).Get(ctx, serviceName, metav1.GetOptions{})
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("Failed to get endpoints: %v", err)), nil
		}

		endpointInfos := []map[string]interface{}{}
		for _, subset := range endpoints.Subsets {
			for _, addr := range subset.Addresses {
				info := map[string]interface{}{
					"ip": addr.IP,
				}
				if addr.TargetRef != nil {
					info["target"] = fmt.Sprintf("%s/%s", addr.TargetRef.Kind, addr.TargetRef.Name)
				}
				endpointInfos = append(endpointInfos, info)
			}
			// Not ready addresses
			for _, addr := range subset.NotReadyAddresses {
				info := map[string]interface{}{
					"ip":     addr.IP,
					"status": "NotReady",
				}
				if addr.TargetRef != nil {
					info["target"] = fmt.Sprintf("%s/%s", addr.TargetRef.Kind, addr.TargetRef.Name)
				}
				endpointInfos = append(endpointInfos, info)
			}
		}

		resultJSON, _ := json.MarshalIndent(endpointInfos, "", "  ")
		return mcp.NewToolResultText(string(resultJSON)), nil
	}
}

func listPodsHandler(clientset *kubernetes.Clientset) func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	return func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		namespace, err := request.RequireString("namespace")
		if err != nil {
			return nil, err
		}

		pods, err := clientset.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{})
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("Failed to list pods: %v", err)), nil
		}

		podList := []map[string]interface{}{}
		for _, pod := range pods.Items {
			podInfo := map[string]interface{}{
				"name":      pod.Name,
				"namespace": pod.Namespace,
				"status":    pod.Status.Phase,
				"ip":        pod.Status.PodIP,
				"node":      pod.Spec.NodeName,
				"age":       pod.CreationTimestamp,
			}
			podList = append(podList, podInfo)
		}

		resultJSON, _ := json.MarshalIndent(podList, "", "  ")
		return mcp.NewToolResultText(string(resultJSON)), nil
	}
}

func listDeploymentsHandler(clientset *kubernetes.Clientset) func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	return func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		namespace, err := request.RequireString("namespace")
		if err != nil {
			return nil, err
		}

		deployments, err := clientset.AppsV1().Deployments(namespace).List(ctx, metav1.ListOptions{})
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("Failed to list deployments: %v", err)), nil
		}

		deployList := []map[string]interface{}{}
		for _, d := range deployments.Items {
			info := map[string]interface{}{
				"name":      d.Name,
				"namespace": d.Namespace,
				"replicas":  d.Status.Replicas,
				"ready":     d.Status.ReadyReplicas,
				"age":       d.CreationTimestamp,
			}
			deployList = append(deployList, info)
		}

		resultJSON, _ := json.MarshalIndent(deployList, "", "  ")
		return mcp.NewToolResultText(string(resultJSON)), nil
	}
}

func listNamespacesHandler(clientset *kubernetes.Clientset) func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	return func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		namespaces, err := clientset.CoreV1().Namespaces().List(ctx, metav1.ListOptions{})
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("Failed to list namespaces: %v", err)), nil
		}

		nsList := []map[string]interface{}{}
		for _, ns := range namespaces.Items {
			info := map[string]interface{}{
				"name":   ns.Name,
				"status": ns.Status.Phase,
				"age":    ns.CreationTimestamp,
			}
			if ns.Labels != nil {
				info["labels"] = ns.Labels
			}
			nsList = append(nsList, info)
		}

		resultJSON, _ := json.MarshalIndent(nsList, "", "  ")
		return mcp.NewToolResultText(string(resultJSON)), nil
	}
}
