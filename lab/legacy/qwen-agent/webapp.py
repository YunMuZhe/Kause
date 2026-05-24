import os

from flask import Flask, jsonify, render_template, request

from run_qwen_agent import build_default_prompt, run_investigation


app = Flask(__name__)


@app.get("/")
def index():
    namespace = os.getenv("QWEN_AGENT_NAMESPACE", "kube-copilot-lab").strip()
    return render_template(
        "index.html",
        default_namespace=namespace,
        default_prompt=build_default_prompt(namespace),
    )


@app.post("/api/investigate")
def investigate():
    payload = request.get_json(silent=True) or {}
    prompt = (payload.get("prompt") or "").strip() or None
    namespace = (payload.get("namespace") or "").strip() or None

    try:
        result = run_investigation(prompt=prompt, namespace=namespace)
        return jsonify({"ok": True, "result": result})
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 500


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=18080, debug=True)
