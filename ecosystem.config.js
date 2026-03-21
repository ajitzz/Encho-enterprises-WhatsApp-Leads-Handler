
module.exports = {
  apps : [{
    name   : "uber-fleet-recruiter",
    script : "./server.js",
    env: {
      NODE_ENV: "production",
    },
    // Auto-restart configuration
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    exp_backoff_restart_delay: 100
  }]
}
