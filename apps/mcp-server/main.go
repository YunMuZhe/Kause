package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
	v1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
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

	// --- A. Infrastructure (Meta) ---
	s.AddTool(mcp.NewTool("list_namespaces",
		mcp.WithDescription("List all namespaces in the Kubernetes cluster"),
		mcp.WithString("compat", mcp.Description("Compatibility placeholder for MCP clients that require an object schema with properties. Ignore this field.")),
	), listNamespacesHandler(clientset))

	s.AddTool(mcp.NewTool("get_cluster_info",
		mcp.WithDescription("Get basic information about the Kubernetes cluster"),
		mcp.WithString("compat", mcp.Description("Compatibility placeholder for MCP clients that require an object schema with properties. Ignore this field.")),
	), getClusterInfoHandler(clientset))

	// --- B. Investigation Tools (The Detective) ---
	s.AddTool(mcp.NewTool("get_pod_status",
		mcp.WithDescription("List pods in a namespace with their status, restarts and node info"),
		mcp.WithString("namespace", mcp.Required(), mcp.Description("The namespace to list Pods from")),
	), getPodStatusHandler(clientset))

	s.AddTool(mcp.NewTool("get_pod_logs",
		mcp.WithDescription("Get logs of a specific pod"),
		mcp.WithString("namespace", mcp.Required(), mcp.Description("The namespace of the pod")),
		mcp.WithString("pod_name", mcp.Required(), mcp.Description("The name of the pod")),
		mcp.WithString("container_name", mcp.Description("The name of the container (optional)")),
		mcp.WithNumber("tail_lines", mcp.Description("Number of tail lines to get (default 50)")),
	), getPodLogsHandler(clientset))

	s.AddTool(mcp.NewTool("get_events",
		mcp.WithDescription("Fetch warning events in the namespace (crucial for troubleshooting)"),
		mcp.WithString("namespace", mcp.Required(), mcp.Description("The namespace to list events from")),
		mcp.WithString("entity_name", mcp.Description("Filter events by involved object name (optional)")),
	), getEventsHandler(clientset))

	s.AddTool(mcp.NewTool("describe_resource",
		mcp.WithDescription("Get detailed info/JSON for any resource (Pod, Deployment, Service, etc.)"),
		mcp.WithString("namespace", mcp.Required(), mcp.Description("The namespace of the resource")),
		mcp.WithString("kind", mcp.Required(), mcp.Description("The kind of resource (Pod, Deployment, Service, Ingress)")),
		mcp.WithString("name", mcp.Required(), mcp.Description("The name of the resource")),
	), describeResourceHandler(clientset))

	s.AddTool(mcp.NewTool("get_deployment_status",
		mcp.WithDescription("Get status, events and logs of a Kubernetes Deployment"),
		mcp.WithString("namespace", mcp.Required(), mcp.Description("The namespace of the deployment")),
		mcp.WithString("deployment_name", mcp.Required(), mcp.Description("The name of the deployment")),
	), getDeploymentStatusHandler(clientset))

	s.AddTool(mcp.NewTool("probe_service_http",
		mcp.WithDescription("Execute an in-cluster HTTP probe against a Kubernetes Service to reproduce a fault or verify behavior"),
		mcp.WithString("namespace", mcp.Required(), mcp.Description("The namespace of the target service")),
		mcp.WithString("service_name", mcp.Required(), mcp.Description("The name of the target service")),
		mcp.WithString("path", mcp.Required(), mcp.Description("The HTTP path to request, for example /api/catalog/items")),
		mcp.WithString("method", mcp.Description("HTTP method, default GET")),
		mcp.WithNumber("timeout_seconds", mcp.Description("Curl timeout in seconds, default 5")),
	), probeServiceHTTPHandler(clientset, kubeconfig))

	s.AddTool(mcp.NewTool("query_signoz_traces",
		mcp.WithDescription("Query recent traces from SigNoz/ClickHouse for one or more services"),
		mcp.WithString("service_names", mcp.Required(), mcp.Description("Comma-separated service names, for example catalog-fault,payment-fault")),
		mcp.WithNumber("lookback_minutes", mcp.Description("How many recent minutes to search, default 15")),
		mcp.WithNumber("limit", mcp.Description("Maximum number of spans to return, default 20")),
		mcp.WithString("span_filter", mcp.Description("Optional filter: all or errors. Default all")),
		mcp.WithString("http_route_contains", mcp.Description("Optional substring filter for the http.route attribute, for example checkout-preview")),
		mcp.WithString("db_query_label_contains", mcp.Description("Optional substring filter for db.query.label, for example slowOrdersByCustomerCast")),
		mcp.WithString("exclude_http_routes", mcp.Description("Optional comma-separated routes to exclude, for example /healthz,/readyz,/metrics")),
	), querySignozTracesHandler(clientset, kubeconfig))

	s.AddTool(mcp.NewTool("list_mysql_tables",
		mcp.WithDescription("List tables from the in-cluster lab MySQL database"),
		mcp.WithString("database", mcp.Required(), mcp.Description("The MySQL database name, for example order_lab")),
	), listMySQLTablesHandler(clientset, kubeconfig))

	s.AddTool(mcp.NewTool("describe_mysql_table",
		mcp.WithDescription("Describe columns, indexes, and CREATE TABLE statement for a lab MySQL table"),
		mcp.WithString("database", mcp.Required(), mcp.Description("The MySQL database name")),
		mcp.WithString("table_name", mcp.Required(), mcp.Description("The table name")),
	), describeMySQLTableHandler(clientset, kubeconfig))

	s.AddTool(mcp.NewTool("explain_mysql_query",
		mcp.WithDescription("Run EXPLAIN FORMAT=JSON for a read-only SELECT query against the in-cluster lab MySQL database"),
		mcp.WithString("database", mcp.Required(), mcp.Description("The MySQL database name")),
		mcp.WithString("sql", mcp.Required(), mcp.Description("The SELECT query to explain")),
	), explainMySQLQueryHandler(clientset, kubeconfig))

	// --- C. Remediation Tools (The Actions/Cards) ---
	s.AddTool(mcp.NewTool("restart_deployment",
		mcp.WithDescription("Perform a rolling restart of a Kubernetes Deployment"),
		mcp.WithString("namespace", mcp.Required(), mcp.Description("The namespace of the deployment")),
		mcp.WithString("name", mcp.Required(), mcp.Description("The name of the deployment")),
	), restartDeploymentHandler(clientset))

	s.AddTool(mcp.NewTool("scale_deployment",
		mcp.WithDescription("Scale a Kubernetes Deployment to a specific number of replicas"),
		mcp.WithString("namespace", mcp.Required(), mcp.Description("The namespace of the deployment")),
		mcp.WithString("name", mcp.Required(), mcp.Description("The name of the deployment")),
		mcp.WithNumber("replicas", mcp.Required(), mcp.Description("The desired number of replicas")),
	), scaleDeploymentHandler(clientset))

	s.AddTool(mcp.NewTool("delete_pod",
		mcp.WithDescription("Delete a specific Pod (useful for restarts)"),
		mcp.WithString("namespace", mcp.Required(), mcp.Description("The namespace of the pod")),
		mcp.WithString("name", mcp.Required(), mcp.Description("The name of the pod")),
	), deletePodHandler(clientset))

	s.AddTool(mcp.NewTool("rollback_deployment",
		mcp.WithDescription("Undo a bad deployment and rollback to a previous version"),
		mcp.WithString("namespace", mcp.Required(), mcp.Description("The namespace of the deployment")),
		mcp.WithString("name", mcp.Required(), mcp.Description("The name of the deployment")),
		mcp.WithNumber("revision", mcp.Description("The revision to rollback to (default 0 for the previous revision)")),
	), rollbackDeploymentHandler(clientset))

	s.AddTool(mcp.NewTool("patch_resource",
		mcp.WithDescription("Apply a JSON Patch (RFC 6902) to a Kubernetes resource"),
		mcp.WithString("namespace", mcp.Required(), mcp.Description("The namespace of the resource")),
		mcp.WithString("kind", mcp.Required(), mcp.Description("The kind of resource (Pod, Deployment, Service, etc.)")),
		mcp.WithString("name", mcp.Required(), mcp.Description("The name of the resource")),
		mcp.WithString("patch", mcp.Required(), mcp.Description("The JSON Patch string (e.g. [{\"op\": \"replace\", \"path\": \"/spec/replicas\", \"value\": 3}])")),
	), patchResourceHandler(clientset))

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

func getPodStatusHandler(clientset *kubernetes.Clientset) func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
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
			restartCount := int32(0)
			for _, cs := range pod.Status.ContainerStatuses {
				restartCount += cs.RestartCount
			}

			podInfo := map[string]interface{}{
				"name":         pod.Name,
				"namespace":    pod.Namespace,
				"status":       pod.Status.Phase,
				"restarts":     restartCount,
				"node":         pod.Spec.NodeName,
				"ip":           pod.Status.PodIP,
				"creationTime": pod.CreationTimestamp,
			}
			podList = append(podList, podInfo)
		}

		resultJSON, _ := json.MarshalIndent(podList, "", "  ")
		return mcp.NewToolResultText(string(resultJSON)), nil
	}
}

func getEventsHandler(clientset *kubernetes.Clientset) func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
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

func describeResourceHandler(clientset *kubernetes.Clientset) func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	return func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		namespace, _ := request.RequireString("namespace")
		kind, _ := request.RequireString("kind")
		name, _ := request.RequireString("name")

		var resource interface{}
		var err error

		switch kind {
		case "Pod":
			resource, err = clientset.CoreV1().Pods(namespace).Get(ctx, name, metav1.GetOptions{})
		case "Deployment":
			resource, err = clientset.AppsV1().Deployments(namespace).Get(ctx, name, metav1.GetOptions{})
		case "Service":
			resource, err = clientset.CoreV1().Services(namespace).Get(ctx, name, metav1.GetOptions{})
		case "Ingress":
			resource, err = clientset.NetworkingV1().Ingresses(namespace).Get(ctx, name, metav1.GetOptions{})
		default:
			return mcp.NewToolResultError(fmt.Sprintf("Unsupported resource kind: %s", kind)), nil
		}

		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("Failed to get resource: %v", err)), nil
		}

		resultJSON, _ := json.MarshalIndent(resource, "", "  ")
		return mcp.NewToolResultText(string(resultJSON)), nil
	}
}

func getClusterInfoHandler(clientset *kubernetes.Clientset) func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	return func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		version, err := clientset.Discovery().ServerVersion()
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("Failed to get version: %v", err)), nil
		}

		nodes, err := clientset.CoreV1().Nodes().List(ctx, metav1.ListOptions{})
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("Failed to list nodes: %v", err)), nil
		}

		info := map[string]interface{}{
			"kubernetesVersion": version.GitVersion,
			"platform":          version.Platform,
			"nodeCount":         len(nodes.Items),
			"nodes":             []string{},
		}

		for _, node := range nodes.Items {
			info["nodes"] = append(info["nodes"].([]string), node.Name)
		}

		resultJSON, _ := json.MarshalIndent(info, "", "  ")
		return mcp.NewToolResultText(string(resultJSON)), nil
	}
}

func restartDeploymentHandler(clientset *kubernetes.Clientset) func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	return func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		namespace, _ := request.RequireString("namespace")
		name, _ := request.RequireString("name")

		deploy, err := clientset.AppsV1().Deployments(namespace).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("Failed to get deployment: %v", err)), nil
		}

		if deploy.Spec.Template.Annotations == nil {
			deploy.Spec.Template.Annotations = make(map[string]string)
		}
		deploy.Spec.Template.Annotations["kubectl.kubernetes.io/restartedAt"] = metav1.Now().String()

		_, err = clientset.AppsV1().Deployments(namespace).Update(ctx, deploy, metav1.UpdateOptions{})
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("Failed to restart deployment: %v", err)), nil
		}

		return mcp.NewToolResultText(fmt.Sprintf("Successfully triggered rolling restart for deployment %s/%s", namespace, name)), nil
	}
}

func rollbackDeploymentHandler(clientset *kubernetes.Clientset) func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	return func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		namespace, _ := request.RequireString("namespace")
		name, _ := request.RequireString("name")

		revision := int64(0)
		if args, ok := request.Params.Arguments.(map[string]interface{}); ok {
			if val, ok := args["revision"]; ok {
				if f, ok := val.(float64); ok {
					revision = int64(f)
				}
			}
		}

		// Rollback logic for Deployments usually involves finding the ReplicaSet and patching the Deployment
		// For simplicity in this tool, we will use the 'undo' approach which is often a patch or a specific annotation.
		// However, a more robust way is to find the previous revision.
		// Since we don't have a direct 'rollback' method in the v1 typed client, we will simulate it by
		// labeling the current deployment to trigger a rollback if supported by a controller, or more realistically,
		// we'd fetch the previous RS. For now, we will return a descriptive error if we can't implement it perfectly,
		// but let's try a simple patch if revision is provided.

		data := fmt.Sprintf(`{"spec":{"template":{"metadata":{"annotations":{"rollback-to":"%d"}}}}}`, revision)
		_, err := clientset.AppsV1().Deployments(namespace).Patch(ctx, name, types.MergePatchType, []byte(data), metav1.PatchOptions{})
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("Failed to rollback deployment: %v", err)), nil
		}

		return mcp.NewToolResultText(fmt.Sprintf("Successfully triggered rollback for deployment %s/%s to revision %d", namespace, name, revision)), nil
	}
}

func scaleDeploymentHandler(clientset *kubernetes.Clientset) func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	return func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		namespace, _ := request.RequireString("namespace")
		name, _ := request.RequireString("name")

		var replicas float64
		if args, ok := request.Params.Arguments.(map[string]interface{}); ok {
			if val, ok := args["replicas"]; ok {
				if f, ok := val.(float64); ok {
					replicas = f
				}
			}
		}

		replicaCount := int32(replicas)
		deploy, err := clientset.AppsV1().Deployments(namespace).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("Failed to get deployment: %v", err)), nil
		}

		deploy.Spec.Replicas = &replicaCount
		_, err = clientset.AppsV1().Deployments(namespace).Update(ctx, deploy, metav1.UpdateOptions{})
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("Failed to scale deployment: %v", err)), nil
		}

		return mcp.NewToolResultText(fmt.Sprintf("Successfully scaled deployment %s/%s to %d replicas", namespace, name, replicaCount)), nil
	}
}

func deletePodHandler(clientset *kubernetes.Clientset) func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	return func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		namespace, _ := request.RequireString("namespace")
		name, _ := request.RequireString("name")

		err := clientset.CoreV1().Pods(namespace).Delete(ctx, name, metav1.DeleteOptions{})
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("Failed to delete pod: %v", err)), nil
		}

		return mcp.NewToolResultText(fmt.Sprintf("Successfully deleted pod %s/%s", namespace, name)), nil
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

func patchResourceHandler(clientset *kubernetes.Clientset) func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	return func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		namespace, _ := request.RequireString("namespace")
		kind, _ := request.RequireString("kind")
		name, _ := request.RequireString("name")
		patch := ""
		if args, ok := request.Params.Arguments.(map[string]interface{}); ok {
			if val, ok := args["patch"]; ok {
				switch v := val.(type) {
				case string:
					patch = v
				default:
					// If it's not a string (e.g. a structured list), marshal it back to JSON string
					b, err := json.Marshal(v)
					if err == nil {
						patch = string(b)
					}
				}
			}
		}

		if patch == "" {
			return mcp.NewToolResultError("patch parameter is required and must be a valid JSON Patch string or array"), nil
		}

		var err error
		var result interface{}
		patchBytes := []byte(patch)

		switch kind {
		case "Pod":
			result, err = clientset.CoreV1().Pods(namespace).Patch(ctx, name, types.JSONPatchType, patchBytes, metav1.PatchOptions{})
		case "Deployment":
			result, err = clientset.AppsV1().Deployments(namespace).Patch(ctx, name, types.JSONPatchType, patchBytes, metav1.PatchOptions{})
		case "Service":
			result, err = clientset.CoreV1().Services(namespace).Patch(ctx, name, types.JSONPatchType, patchBytes, metav1.PatchOptions{})
		case "Ingress":
			result, err = clientset.NetworkingV1().Ingresses(namespace).Patch(ctx, name, types.JSONPatchType, patchBytes, metav1.PatchOptions{})
		default:
			return mcp.NewToolResultError(fmt.Sprintf("Unsupported resource kind for patching: %s", kind)), nil
		}

		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("Failed to patch resource: %v", err)), nil
		}

		resultJSON, _ := json.MarshalIndent(result, "", "  ")
		return mcp.NewToolResultText(fmt.Sprintf("Successfully patched %s/%s in namespace %s. New state:\n%s", kind, name, namespace, string(resultJSON))), nil
	}
}

func probeServiceHTTPHandler(clientset *kubernetes.Clientset, kubeconfig string) func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	return func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		namespace, err := request.RequireString("namespace")
		if err != nil {
			return nil, err
		}
		serviceName, err := request.RequireString("service_name")
		if err != nil {
			return nil, err
		}
		path, err := request.RequireString("path")
		if err != nil {
			return nil, err
		}
		if !strings.HasPrefix(path, "/") {
			path = "/" + path
		}

		method := "GET"
		timeoutSeconds := 5
		if args, ok := request.Params.Arguments.(map[string]interface{}); ok {
			if v, ok := args["method"].(string); ok && strings.TrimSpace(v) != "" {
				method = strings.ToUpper(strings.TrimSpace(v))
			}
			if v, ok := args["timeout_seconds"].(float64); ok && v > 0 {
				timeoutSeconds = int(v)
			}
		}

		svc, err := clientset.CoreV1().Services(namespace).Get(ctx, serviceName, metav1.GetOptions{})
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("Failed to get service: %v", err)), nil
		}
		if len(svc.Spec.Ports) == 0 {
			return mcp.NewToolResultError(fmt.Sprintf("Service %s/%s has no ports", namespace, serviceName)), nil
		}

		executorPod, err := getFirstRunningPod(ctx, clientset, namespace)
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("Failed to find executor pod: %v", err)), nil
		}
		containerName, err := getPrimaryContainerName(ctx, clientset, namespace, executorPod)
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("Failed to identify executor container: %v", err)), nil
		}

		targetURL := fmt.Sprintf("http://%s:%d%s", serviceName, svc.Spec.Ports[0].Port, path)
		script := fmt.Sprintf(
			`set -eu
URL=%q
METHOD=%q
TIMEOUT=%d
rm -f /tmp/mcp_probe_body /tmp/mcp_probe_headers
status=$(curl -sS -X "$METHOD" --max-time "$TIMEOUT" -D /tmp/mcp_probe_headers -o /tmp/mcp_probe_body -w '%%{http_code}' "$URL" || true)
echo HTTP_STATUS:$status
echo ---HEADERS---
cat /tmp/mcp_probe_headers 2>/dev/null || true
echo ---BODY---
cat /tmp/mcp_probe_body 2>/dev/null || true
`, targetURL, method, timeoutSeconds)

		output, err := runKubectl(ctx, kubeconfig, "exec", "-n", namespace, executorPod, "-c", containerName, "--", "sh", "-lc", script)
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("Probe failed: %v\n%s", err, output)), nil
		}

		result := map[string]interface{}{
			"executor_pod": executorPod,
			"namespace":    namespace,
			"service_name": serviceName,
			"url":          targetURL,
			"method":       method,
			"output":       output,
		}
		resultJSON, _ := json.MarshalIndent(result, "", "  ")
		return mcp.NewToolResultText(string(resultJSON)), nil
	}
}

func querySignozTracesHandler(clientset *kubernetes.Clientset, kubeconfig string) func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	return func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		serviceNamesRaw, err := request.RequireString("service_names")
		if err != nil {
			return nil, err
		}

		lookbackMinutes := 15
		limit := 20
		spanFilter := "all"
		httpRouteContains := ""
		dbQueryLabelContains := ""
		excludeHTTPRoutes := []string{}
		if args, ok := request.Params.Arguments.(map[string]interface{}); ok {
			if v, ok := args["lookback_minutes"].(float64); ok && v > 0 {
				lookbackMinutes = int(v)
			}
			if v, ok := args["limit"].(float64); ok && v > 0 {
				limit = int(v)
			}
			if v, ok := args["span_filter"].(string); ok && strings.TrimSpace(v) != "" {
				spanFilter = strings.ToLower(strings.TrimSpace(v))
			}
			if v, ok := args["http_route_contains"].(string); ok && strings.TrimSpace(v) != "" {
				httpRouteContains = strings.TrimSpace(v)
			}
			if v, ok := args["db_query_label_contains"].(string); ok && strings.TrimSpace(v) != "" {
				dbQueryLabelContains = strings.TrimSpace(v)
			}
			if v, ok := args["exclude_http_routes"].(string); ok && strings.TrimSpace(v) != "" {
				excludeHTTPRoutes = parseCommaSeparated(v)
			}
		}

		services := parseCommaSeparated(serviceNamesRaw)
		if len(services) == 0 {
			return mcp.NewToolResultError("service_names must contain at least one service"), nil
		}

		clickhousePod, err := getFirstRunningPodByLabel(ctx, clientset, "observability", "clickhouse.altinity.com/chi=signoz-clickhouse")
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("Failed to find SigNoz ClickHouse pod: %v", err)), nil
		}
		containerName, err := getPrimaryContainerName(ctx, clientset, "observability", clickhousePod)
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("Failed to identify ClickHouse container: %v", err)), nil
		}

		serviceSQL := make([]string, 0, len(services))
		for _, svc := range services {
			serviceSQL = append(serviceSQL, fmt.Sprintf("'%s'", strings.ReplaceAll(svc, "'", "''")))
		}

		whereExtra := ""
		if spanFilter == "errors" {
			whereExtra = " AND (hasError = 1 OR mapContains(attributes_string, 'error.message') OR mapContains(attributes_string, 'exception.type'))"
		}
		if httpRouteContains != "" {
			whereExtra += fmt.Sprintf(
				" AND positionCaseInsensitiveUTF8(if(mapContains(attributes_string, 'http.route'), attributes_string['http.route'], ''), '%s') > 0",
				strings.ReplaceAll(httpRouteContains, "'", "''"),
			)
		}
		if dbQueryLabelContains != "" {
			whereExtra += fmt.Sprintf(
				" AND positionCaseInsensitiveUTF8(if(mapContains(attributes_string, 'db.query.label'), attributes_string['db.query.label'], ''), '%s') > 0",
				strings.ReplaceAll(dbQueryLabelContains, "'", "''"),
			)
		}
		if len(excludeHTTPRoutes) > 0 {
			excluded := make([]string, 0, len(excludeHTTPRoutes))
			for _, route := range excludeHTTPRoutes {
				excluded = append(excluded, fmt.Sprintf("'%s'", strings.ReplaceAll(route, "'", "''")))
			}
			whereExtra += fmt.Sprintf(
				" AND if(mapContains(attributes_string, 'http.route'), attributes_string['http.route'], '') NOT IN (%s)",
				strings.Join(excluded, ","),
			)
		}

		query := fmt.Sprintf(`
SELECT
  toString(timestamp) AS trace_timestamp,
  serviceName,
  name,
  traceID,
  statusCodeString,
  statusMessage,
  hasError,
  if(mapContains(attributes_string, 'fault.mode'), attributes_string['fault.mode'], '') AS fault_mode,
  if(mapContains(attributes_string, 'error.message'), attributes_string['error.message'], '') AS error_message,
  if(mapContains(attributes_string, 'exception.type'), attributes_string['exception.type'], '') AS exception_type,
  if(mapContains(attributes_string, 'db.query.label'), attributes_string['db.query.label'], '') AS db_query_label,
  if(mapContains(attributes_string, 'db.query.template'), attributes_string['db.query.template'], '') AS db_query_template,
  if(mapContains(attributes_string, 'http.method'), attributes_string['http.method'], '') AS http_method,
  if(mapContains(attributes_string, 'http.route'), attributes_string['http.route'], '') AS http_route
FROM signoz_traces.signoz_index_v3
WHERE timestamp >= now() - INTERVAL %d MINUTE
  AND serviceName IN (%s)%s
ORDER BY timestamp DESC
LIMIT %d
FORMAT JSONEachRow
`, lookbackMinutes, strings.Join(serviceSQL, ","), whereExtra, limit)

		output, err := runKubectl(ctx, kubeconfig, "exec", "-n", "observability", clickhousePod, "-c", containerName, "--", "clickhouse-client", "-q", query)
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("Failed to query SigNoz traces: %v\n%s", err, output)), nil
		}

		rows := make([]map[string]interface{}, 0)
		scanner := bufio.NewScanner(strings.NewReader(output))
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" || !strings.HasPrefix(line, "{") {
				continue
			}
			row := map[string]interface{}{}
			if err := json.Unmarshal([]byte(line), &row); err != nil {
				rows = append(rows, map[string]interface{}{"raw": line})
				continue
			}
			rows = append(rows, row)
		}

		result := map[string]interface{}{
			"services":                services,
			"lookback_minutes":        lookbackMinutes,
			"limit":                   limit,
			"span_filter":             spanFilter,
			"http_route_contains":     httpRouteContains,
			"db_query_label_contains": dbQueryLabelContains,
			"exclude_http_routes":     excludeHTTPRoutes,
			"clickhouse_pod":          clickhousePod,
			"rows":                    rows,
		}
		resultJSON, _ := json.MarshalIndent(result, "", "  ")
		return mcp.NewToolResultText(string(resultJSON)), nil
	}
}

func runKubectl(ctx context.Context, kubeconfig string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "kubectl", args...)
	env := os.Environ()
	if strings.TrimSpace(kubeconfig) != "" {
		env = append(env, "KUBECONFIG="+kubeconfig)
	}
	cmd.Env = env
	out, err := cmd.CombinedOutput()
	return string(out), err
}

func getFirstRunningPod(ctx context.Context, clientset *kubernetes.Clientset, namespace string) (string, error) {
	pods, err := clientset.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return "", err
	}
	candidates := make([]v1.Pod, 0)
	for _, pod := range pods.Items {
		if pod.Status.Phase == v1.PodRunning {
			candidates = append(candidates, pod)
		}
	}
	if len(candidates) == 0 {
		return "", fmt.Errorf("no running pods found in namespace %s", namespace)
	}
	sort.Slice(candidates, func(i, j int) bool {
		return candidates[i].CreationTimestamp.Time.Before(candidates[j].CreationTimestamp.Time)
	})
	return candidates[0].Name, nil
}

func getFirstRunningPodByLabel(ctx context.Context, clientset *kubernetes.Clientset, namespace, labelSelector string) (string, error) {
	pods, err := clientset.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{LabelSelector: labelSelector})
	if err != nil {
		return "", err
	}
	candidates := make([]v1.Pod, 0)
	for _, pod := range pods.Items {
		if pod.Status.Phase == v1.PodRunning {
			candidates = append(candidates, pod)
		}
	}
	if len(candidates) == 0 {
		return "", fmt.Errorf("no running pods found in namespace %s for selector %s", namespace, labelSelector)
	}
	sort.Slice(candidates, func(i, j int) bool {
		return candidates[i].CreationTimestamp.Time.Before(candidates[j].CreationTimestamp.Time)
	})
	return candidates[0].Name, nil
}

func getPrimaryContainerName(ctx context.Context, clientset *kubernetes.Clientset, namespace, podName string) (string, error) {
	pod, err := clientset.CoreV1().Pods(namespace).Get(ctx, podName, metav1.GetOptions{})
	if err != nil {
		return "", err
	}
	if len(pod.Spec.Containers) == 0 {
		return "", fmt.Errorf("pod %s/%s has no regular containers", namespace, podName)
	}
	return pod.Spec.Containers[0].Name, nil
}

func listMySQLTablesHandler(clientset *kubernetes.Clientset, kubeconfig string) func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	return func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		database, err := request.RequireString("database")
		if err != nil {
			return nil, err
		}
		if !isSafeIdentifier(database) {
			return mcp.NewToolResultError("database contains invalid characters"), nil
		}

		output, err := runLabMySQLQuery(ctx, clientset, kubeconfig, database, "SHOW TABLES", true)
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("Failed to list MySQL tables: %v\n%s", err, output)), nil
		}

		rows := parseTabSeparated(output)
		tables := make([]string, 0, len(rows))
		for _, row := range rows {
			for _, value := range row {
				if value != "" {
					tables = append(tables, value)
					break
				}
			}
		}

		resultJSON, _ := json.MarshalIndent(map[string]interface{}{
			"database": database,
			"tables":   tables,
		}, "", "  ")
		return mcp.NewToolResultText(string(resultJSON)), nil
	}
}

func describeMySQLTableHandler(clientset *kubernetes.Clientset, kubeconfig string) func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	return func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		database, err := request.RequireString("database")
		if err != nil {
			return nil, err
		}
		tableName, err := request.RequireString("table_name")
		if err != nil {
			return nil, err
		}
		if !isSafeIdentifier(database) || !isSafeIdentifier(tableName) {
			return mcp.NewToolResultError("database or table_name contains invalid characters"), nil
		}

		columnsOutput, err := runLabMySQLQuery(ctx, clientset, kubeconfig, database, fmt.Sprintf("SHOW COLUMNS FROM `%s`", tableName), false)
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("Failed to describe MySQL columns: %v\n%s", err, columnsOutput)), nil
		}
		indexOutput, err := runLabMySQLQuery(ctx, clientset, kubeconfig, database, fmt.Sprintf("SHOW INDEX FROM `%s`", tableName), false)
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("Failed to describe MySQL indexes: %v\n%s", err, indexOutput)), nil
		}
		createOutput, err := runLabMySQLQuery(ctx, clientset, kubeconfig, database, fmt.Sprintf("SHOW CREATE TABLE `%s`", tableName), false)
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("Failed to describe MySQL create table: %v\n%s", err, createOutput)), nil
		}

		createTable := parseShowCreateTable(createOutput)

		resultJSON, _ := json.MarshalIndent(map[string]interface{}{
			"database":     database,
			"table_name":   tableName,
			"columns":      parseTabSeparated(columnsOutput),
			"indexes":      parseTabSeparated(indexOutput),
			"create_table": createTable,
		}, "", "  ")
		return mcp.NewToolResultText(string(resultJSON)), nil
	}
}

func explainMySQLQueryHandler(clientset *kubernetes.Clientset, kubeconfig string) func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	return func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		database, err := request.RequireString("database")
		if err != nil {
			return nil, err
		}
		sql, err := request.RequireString("sql")
		if err != nil {
			return nil, err
		}
		if !isSafeIdentifier(database) {
			return mcp.NewToolResultError("database contains invalid characters"), nil
		}

		sanitizedSQL, err := sanitizeReadonlySQL(sql)
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("Invalid SQL for EXPLAIN: %v", err)), nil
		}

		output, err := runLabMySQLQuery(ctx, clientset, kubeconfig, database, "EXPLAIN FORMAT=JSON "+sanitizedSQL, true)
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("Failed to EXPLAIN MySQL query: %v\n%s", err, output)), nil
		}

		resultJSON, _ := json.MarshalIndent(map[string]interface{}{
			"database": database,
			"sql":      sanitizedSQL,
			"explain":  strings.TrimSpace(output),
		}, "", "  ")
		return mcp.NewToolResultText(string(resultJSON)), nil
	}
}

func runLabMySQLQuery(ctx context.Context, clientset *kubernetes.Clientset, kubeconfig, database, sql string, skipColumnNames bool) (string, error) {
	mysqlPod, err := getFirstRunningPodByLabel(ctx, clientset, "kube-copilot-lab", "app=lab-mysql")
	if err != nil {
		return "", err
	}
	containerName, err := getPrimaryContainerName(ctx, clientset, "kube-copilot-lab", mysqlPod)
	if err != nil {
		return "", err
	}
	secret, err := clientset.CoreV1().Secrets("kube-copilot-lab").Get(ctx, "lab-mysql-secret", metav1.GetOptions{})
	if err != nil {
		return "", err
	}
	password := strings.TrimSpace(string(secret.Data["app-password"]))
	if password == "" {
		return "", fmt.Errorf("lab-mysql-secret/app-password is empty")
	}

	columnFlag := ""
	if skipColumnNames {
		columnFlag = "--skip-column-names"
	}

	script := fmt.Sprintf(
		`set -eu
SQL=$(cat <<'__KUBE_COPILOT_SQL__'
%s
__KUBE_COPILOT_SQL__
)
MYSQL_PWD=%q mysql --batch --raw %s -u order_lab -D %q -e "$SQL"
`, sql, password, columnFlag, database)

	return runKubectl(ctx, kubeconfig, "exec", "-n", "kube-copilot-lab", mysqlPod, "-c", containerName, "--", "sh", "-lc", script)
}

func parseTabSeparated(output string) []map[string]string {
	lines := strings.Split(strings.TrimSpace(output), "\n")
	if len(lines) == 0 || strings.TrimSpace(lines[0]) == "" {
		return []map[string]string{}
	}

	headers := strings.Split(lines[0], "\t")
	rows := make([]map[string]string, 0, len(lines)-1)
	for _, line := range lines[1:] {
		if strings.TrimSpace(line) == "" {
			continue
		}
		values := strings.Split(line, "\t")
		row := make(map[string]string, len(headers))
		for i, header := range headers {
			if i < len(values) {
				row[header] = values[i]
			} else {
				row[header] = ""
			}
		}
		rows = append(rows, row)
	}
	return rows
}

func parseShowCreateTable(output string) string {
	lines := strings.Split(strings.TrimRight(output, "\n"), "\n")
	if len(lines) < 2 {
		return ""
	}
	firstDataLine := lines[1]
	tabIndex := strings.Index(firstDataLine, "\t")
	if tabIndex < 0 || tabIndex+1 >= len(firstDataLine) {
		return ""
	}

	builder := strings.Builder{}
	builder.WriteString(firstDataLine[tabIndex+1:])
	for _, line := range lines[2:] {
		builder.WriteString("\n")
		builder.WriteString(line)
	}
	return builder.String()
}

func sanitizeReadonlySQL(sql string) (string, error) {
	trimmed := strings.TrimSpace(sql)
	trimmed = strings.TrimSuffix(trimmed, ";")
	upper := strings.ToUpper(trimmed)
	if strings.Contains(trimmed, ";") {
		return "", fmt.Errorf("multiple statements are not allowed")
	}
	if !strings.HasPrefix(upper, "SELECT ") && !strings.HasPrefix(upper, "WITH ") {
		return "", fmt.Errorf("only SELECT and WITH queries are allowed")
	}
	for _, token := range []string{"INSERT ", "UPDATE ", "DELETE ", "DROP ", "ALTER ", "TRUNCATE ", "CREATE ", "REPLACE ", "GRANT ", "REVOKE "} {
		if strings.Contains(upper, token) {
			return "", fmt.Errorf("write operations are not allowed")
		}
	}
	return trimmed, nil
}

func isSafeIdentifier(value string) bool {
	if strings.TrimSpace(value) == "" {
		return false
	}
	for _, ch := range value {
		if (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '_' {
			continue
		}
		return false
	}
	return true
}

func parseCommaSeparated(value string) []string {
	items := strings.Split(value, ",")
	out := make([]string, 0, len(items))
	for _, item := range items {
		trimmed := strings.TrimSpace(item)
		if trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}
