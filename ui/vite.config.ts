import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const ckbRpcUrl = env.VITE_CKB_RPC_URL || 'http://127.0.0.1:28114'

  return {
    plugins: [react()],
    server: {
      fs: {
        // Allow serving deployment/*.json, which lives one level above this
        // package (ui/), so the browser bundle can read the same contract
        // deployment info as offchain/ and backend/.
        allow: ['..'],
      },
      proxy: {
        // The local CKB RPC node has no CORS headers, so the browser talks to
        // it through this dev-server proxy instead of connecting directly.
        '/api/ckb-rpc': {
          target: ckbRpcUrl,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/ckb-rpc/, ''),
        },
      },
    },
  }
})
