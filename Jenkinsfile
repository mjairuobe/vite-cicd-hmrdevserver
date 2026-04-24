// Vite Dev Remote Pipeline.
// Triggers a sync on the long-running supervisor and streams its state until terminal.
pipeline {
  agent any

  options {
    disableConcurrentBuilds()                 // singleton at the job level
    timeout(time: 5, unit: 'MINUTES')         // hard ceiling so a stuck sync never blocks forever
    timestamps()
    ansiColor('xterm')
  }

  environment {
    SUPERVISOR_URL = "${env.SUPERVISOR_URL ?: 'http://dev-host.internal:40890'}"
  }

  stages {
    stage('Trigger Sync') {
      steps {
        // Lockable Resources guards across jobs (e.g. multiple branches sharing one devserver).
        lock(resource: 'vite-dev-remote', inversePrecedence: true) {
          script {
            def ref = env.BRANCH_NAME ?: 'main'

            // Optional auth header — set SUPERVISOR_SECRET as a Jenkins credential
            // and bind it to the env block, then it's auto-included in curl calls.
            def authHeader = env.SUPERVISOR_SECRET ? "-H 'X-Shared-Secret: ${env.SUPERVISOR_SECRET}'" : ""

            def runId = sh(
              returnStdout: true,
              script: """
                curl -fsS -X POST ${SUPERVISOR_URL}/sync ${authHeader} \\
                  -H 'Content-Type: application/json' \\
                  -d '{"ref":"${ref}"}' \\
                | jq -r .runId
              """
            ).trim()
            echo "Started sync run: ${runId}"

            // Stream state transitions until READY / BUILD_ERROR / CRASHED.
            // The supervisor closes the SSE stream on terminal state.
            sh """
              curl -fsS -N "${SUPERVISOR_URL}/events?runId=${runId}" \\
                | awk '/^data:/ { sub(/^data: /,""); print; if (/READY|BUILD_ERROR|CRASHED/) exit 0 }'
            """

            def finalState = sh(
              returnStdout: true,
              script: "curl -fsS ${SUPERVISOR_URL}/status | jq -r .state"
            ).trim()
            echo "Final state: ${finalState}"

            if (finalState != 'READY') {
              error "sync did not reach READY (final: ${finalState})"
            }
          }
        }
      }
    }
  }

  post {
    failure {
      // Surface the last 50 supervisor log entries to make CI failures debuggable.
      sh """
        curl -fsS "${SUPERVISOR_URL}/logs?limit=50" | jq -r '.entries[] | "\\(.ts) [\\(.levelLabel)] \\(.msg)"' || true
      """
    }
  }
}
