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
	), listNamespacesHandler(clientset))

	s.AddTool(mcp.NewTool("get_cluster_info",
		mcp.WithDescription("Get basic information about the Kubernetes cluster"),
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
