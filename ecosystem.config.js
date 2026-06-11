module.exports = {
  apps: [
    {
      name: "imap-scanner",
      script: "imap_search.js",
      args: "--loop",
      cwd: "./",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "200M",
      env: {
        NODE_ENV: "production",
        IMAP_LOOP: "true",
        IMAP_POLL_INTERVAL_MS: "1800000"
      }
    }
  ]
};
