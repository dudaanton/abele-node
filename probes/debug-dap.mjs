// B0-only, deliberately small DAP client. Not a production transport.
import { EventEmitter } from 'node:events'

export function frame(message) {
  const body = Buffer.from(JSON.stringify(message))
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body])
}

export class Dap extends EventEmitter {
  constructor(input, output, { timeout = 15000, reverse, log = () => {} } = {}) {
    super()
    this.input = input
    this.output = output
    this.timeout = timeout
    this.reverse = reverse
    this.log = log
    this.seq = 0
    this.cursor = 0
    this.events = []
    this.pending = new Map()
    this.buffer = Buffer.alloc(0)
    this.onData = (bytes) => {
      try {
        this.buffer = Buffer.concat([this.buffer, bytes])
        while (true) {
          const end = this.buffer.indexOf('\r\n\r\n')
          if (end === -1) break
          const match = /^Content-Length: (\d+)\r?$/im.exec(this.buffer.subarray(0, end).toString())
          if (!match || Number(match[1]) > 8 * 1024 * 1024) throw new Error('invalid DAP frame')
          const length = Number(match[1])
          if (this.buffer.length < end + 4 + length) break
          const message = JSON.parse(this.buffer.subarray(end + 4, end + 4 + length).toString())
          this.buffer = this.buffer.subarray(end + 4 + length)
          this.receive(message)
        }
      } catch (error) {
        this.close(error)
      }
    }
    this.onEnd = () => this.close(new Error('DAP closed'))
    input.on('data', this.onData)
    input.on('end', this.onEnd)
    input.on('error', this.onEnd)
  }

  send(message) {
    if (this.closed) throw new Error('DAP closed')
    this.log('send', message)
    this.output.write(frame(message))
  }

  receive(message) {
    this.log('receive', message)
    if (message.type === 'response') {
      const pending = this.pending.get(message.request_seq)
      if (!pending) return
      this.pending.delete(message.request_seq)
      clearTimeout(pending.timer)
      if (message.success) pending.resolve(message.body ?? {})
      else
        pending.reject(
          new Error(`${message.command}: ${message.message ?? JSON.stringify(message.body)}`)
        )
    } else if (message.type === 'event') {
      const event = { ...message, cursor: ++this.cursor }
      this.events.push(event)
      this.emit('event', event)
    } else if (message.type === 'request') {
      Promise.resolve()
        .then(() => {
          if (!this.reverse) throw new Error(`unsupported reverse request ${message.command}`)
          return this.reverse(message)
        })
        .then(
          (body) =>
            this.send({
              seq: ++this.seq,
              type: 'response',
              request_seq: message.seq,
              command: message.command,
              success: true,
              body,
            }),
          (error) => {
            if (!this.closed)
              this.send({
                seq: ++this.seq,
                type: 'response',
                request_seq: message.seq,
                command: message.command,
                success: false,
                message: error.message,
              })
          }
        )
        .catch((error) => this.close(error))
    }
  }

  request(command, args = {}) {
    const seq = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq)
        reject(new Error(`${command} timeout`))
      }, this.timeout)
      this.pending.set(seq, { resolve, reject, timer })
      try {
        this.send({ seq, type: 'request', command, arguments: args })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(seq)
        reject(error)
      }
    })
  }

  event(name, predicate = () => true, after = 0) {
    const matches = (event) => event.cursor > after && event.event === name && predicate(event)
    const found = this.events.find(matches)
    if (found) return Promise.resolve(found)
    if (this.closed) return Promise.reject(new Error('DAP closed'))
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer)
        this.off('event', listener)
        this.off('closed', closed)
      }
      const listener = (event) => {
        if (matches(event)) {
          cleanup()
          resolve(event)
        }
      }
      const closed = (error) => {
        cleanup()
        reject(error)
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(`event ${name} timeout`))
      }, this.timeout)
      this.on('event', listener)
      this.on('closed', closed)
    })
  }

  close(error = new Error('DAP closed')) {
    if (this.closed) return
    this.closed = true
    this.input.off('data', this.onData)
    this.input.off('end', this.onEnd)
    this.input.off('error', this.onEnd)
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer)
      reject(error)
    }
    this.pending.clear()
    this.emit('closed', error)
  }
}
