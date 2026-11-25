/**
 * SSE event hub and active client tab focus/visibility tracker.
 * Broadcasts real-time hook notifications, dismissal cues, and script logs.
 */

const DEFAULT_HEARTBEAT_MS = 15_000
const DEFAULT_MAX_BUFFER_BYTES = 4 * 1024 * 1024
const DEFAULT_CLIENT_TTL_MS = 90_000

/**
 * Create an SSE hub tracking connected tabs and focus state.
 * @param {{ heartbeatMs?: number, maxBufferBytes?: number, clientTtlMs?: number, now?: () => number }} [opts]
 */
export function createEventHub({
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
  maxBufferBytes = DEFAULT_MAX_BUFFER_BYTES,
  clientTtlMs = DEFAULT_CLIENT_TTL_MS,
  now = Date.now,
} = {}) {
  const encoder = new TextEncoder()
  const clients = new Set()
  const clientStates = new Map()
  let closing = false

  function pruneStaleClients() {
    const cutoff = now() - clientTtlMs
    for (const [id, entry] of clientStates) {
      if (entry.updatedAt < cutoff) {
        clientStates.delete(id)
      }
    }
  }

  function open(request) {
    if (closing) {
      return new Response('Hook events are closing', { status: 503 })
    }

    let controller
    let heartbeat
    let closed = false
    let overflow = false
    let clientRecord

    function finish(closeStream = true) {
      if (closed) return
      closed = true
      if (heartbeat) clearInterval(heartbeat)
      heartbeat = undefined
      request?.signal?.removeEventListener?.('abort', onAbort)
      if (clientRecord) clients.delete(clientRecord)
      if (closeStream && controller) {
        try {
          controller.close()
        } catch {
          // Stream may already be closed/errored
        }
      }
    }

    function onAbort() {
      finish(true)
    }

    function send(text) {
      if (closed || !controller) return false
      const bytes = encoder.encode(text)
      if (controller.desiredSize !== null && bytes.byteLength > controller.desiredSize) {
        overflow = true
        finish(true)
        return false
      }
      try {
        controller.enqueue(bytes)
        return true
      } catch {
        finish(false)
        return false
      }
    }

    clientRecord = { send, finish }

    const body = new ReadableStream(
      {
        start(ctrl) {
          controller = ctrl
        },
        cancel() {
          finish(false)
        },
      },
      {
        highWaterMark: maxBufferBytes,
        size: (chunk) => chunk.byteLength,
      },
    )

    clients.add(clientRecord)
    request?.signal?.addEventListener?.('abort', onAbort, { once: true })

    if (request?.signal?.aborted) {
      finish(true)
    } else {
      send(': connected\n\n')
      if (!closed && !overflow) {
        heartbeat = setInterval(() => send(': heartbeat\n\n'), heartbeatMs)
        heartbeat.unref?.()
      }
    }

    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        'x-accel-buffering': 'no',
      },
    })
  }

  /**
   * Broadcast a named SSE JSON event to all connected clients.
   * @param {string} eventName
   * @param {unknown} data
   */
  function broadcast(eventName, data) {
    if (closing || clients.size === 0) return 0
    const frame = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`
    let delivered = 0
    for (const client of [...clients]) {
      if (client.send(frame)) delivered++
    }
    return delivered
  }

  /**
   * Update focus/visibility presence for a browser/Desktop tab.
   * @param {{ clientId: string, focused?: boolean, visible?: boolean, closing?: boolean }} state
   */
  function updateClientState({ clientId, focused = false, visible = false, closing: tabClosing = false } = {}) {
    pruneStaleClients()
    if (typeof clientId !== 'string' || !clientId.trim() || clientId.length > 128) {
      return
    }
    const id = clientId.trim()
    if (tabClosing) {
      clientStates.delete(id)
      return
    }
    clientStates.set(id, {
      focused: Boolean(focused),
      visible: Boolean(visible),
      updatedAt: now(),
    })
  }

  function hasFocusedVisibleClient() {
    pruneStaleClients()
    for (const state of clientStates.values()) {
      if (state.focused && state.visible) return true
    }
    return false
  }

  function getFocusedClientCount() {
    pruneStaleClients()
    let count = 0
    for (const state of clientStates.values()) {
      if (state.focused && state.visible) count++
    }
    return count
  }

  function getConnectedClientCount() {
    pruneStaleClients()
    return clients.size > 0 ? clients.size : clientStates.size
  }

  function close() {
    closing = true
    for (const client of [...clients]) {
      client.finish(true)
    }
    clients.clear()
    clientStates.clear()
  }

  return {
    open,
    broadcast,
    updateClientState,
    hasFocusedVisibleClient,
    getFocusedClientCount,
    getConnectedClientCount,
    close,
  }
}
