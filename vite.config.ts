import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { resolve } from 'path';

export default defineConfig({
  plugins: [basicSsl()],
  server: { host: true, port: 5173 },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        sender: resolve(__dirname, 'sender.html'),
        receiver: resolve(__dirname, 'receiver.html'),
      },
    },
  },
});
