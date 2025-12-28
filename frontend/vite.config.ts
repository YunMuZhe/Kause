import { fileURLToPath } from 'url'
import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "./src"),
        },
    },
    server: {
        proxy: {
            // 代理所有 /api 请求到后端
            '/api': {
                target: 'http://127.0.0.1:8000',
                changeOrigin: true,
            },
            // 代理 /chat 请求
            '/chat': {
                target: 'http://127.0.0.1:8000',
                changeOrigin: true,
            },
            // 代理 /playbooks 请求
            '/playbooks': {
                target: 'http://127.0.0.1:8000',
                changeOrigin: true,
            },
        },
    },
})
