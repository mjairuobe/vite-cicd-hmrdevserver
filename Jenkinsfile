// Vite Dev Remote Pipeline — https://github.com/mjairuobe/vite-cicd-hmrdevserver
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
    SUPERVISOR_URL = "${env.SUPERVISOR_URL ?: 'http://127.0.0.1:40890'}"
  }

  stages {
    stage('Trigger Sync') {
      steps {
        // Lockable Resources guards across jobs (e.g. multiple branches sharing one devserver).
        lock(resource: 'vite-dev-remote', inversePrecedence: true) {
          script {
            // BRANCH_NAME fehlt bei vielen nicht-Multibranch-Jobs → sonst fälschlich "main" und alter Stand ohne Monorepo.
            def ref = env.BRANCH_NAME?.trim()
            if (!ref) {
              ref = sh(returnStdout: true, script: 'git -C "${WORKSPACE}" rev-parse --abbrev-ref HEAD').trim()
            }
            if (!ref || ref == 'HEAD') {
              ref = 'master'
            }
            echo "Supervisor sync ref: ${ref}"

            // Optional auth header — set SUPERVISOR_SECRET as a Jenkins credential
            // and bind it to the env block, then it's auto-included in curl calls.
            def authHeader = env.SUPERVISOR_SECRET ? "-H 'X-Shared-Secret: ${env.SUPERVISOR_SECRET}'" : ""

            // Supervisor bindet HTTP jetzt vor coldBoot; bis dahin kann /sync 409 (Mutex) liefern — kurz retry.
            def runId = sh(
              returnStdout: true,
              script: """
                set -e
                for i in \\$(seq 1 180); do
                  if curl -fsS -o /dev/null '${SUPERVISOR_URL}/status' 2>/dev/null; then break; fi
                  sleep 1
                done
                runId=""
                for i in \\$(seq 1 120); do
                  code=\\$(curl -sS -o /tmp/sync.json -w '%{http_code}' -X POST '${SUPERVISOR_URL}/sync' ${authHeader} \\
                    -H 'Content-Type: application/json' \\
                    -d '{\"ref\":\"${ref}\"}' || echo 000)
                  if [ "\\$code" = "202" ]; then
                    runId=\\$(jq -r .runId /tmp/sync.json)
                    if [ -n "\\$runId" ] && [ "\\$runId" != "null" ]; then echo "\\$runId"; exit 0; fi
                  fi
                  sleep 2
                done
                echo "supervisor /sync: no 202 after retries (last http \\$code)" >&2
                exit 1
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
