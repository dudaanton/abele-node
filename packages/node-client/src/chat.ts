import {
  ChatMethodSchemas,
  ChatCheckpointSchema,
  ChatPreviewSchema,
  ChatRestoreResultSchema,
  type ChatRestoreRequest,
  type ChatCheckpointsRequest,
} from '@abele/node-protocol'

/** Restores are online owner actions. Only pass restore_files after showing its preview. */
export class ChatClient {
  constructor(
    private rpc: (method: string, params: unknown, operation?: string) => Promise<unknown>
  ) {}
  async checkpoints(session_id: string, options: Omit<ChatCheckpointsRequest, 'session_id'> = {}) {
    return ChatCheckpointSchema.array().parse(
      await this.rpc(
        'chat.checkpoints',
        ChatMethodSchemas['chat.checkpoints'].parse({ ...options, session_id })
      )
    )
  }
  async preview(session_id: string, checkpoint_id: string) {
    return ChatPreviewSchema.parse(
      await this.rpc(
        'chat.preview',
        ChatMethodSchemas['chat.preview'].parse({ session_id, checkpoint_id })
      )
    )
  }
  async restore(request: ChatRestoreRequest, operation = globalThis.crypto.randomUUID()) {
    return ChatRestoreResultSchema.parse(
      await this.rpc('chat.restore', ChatMethodSchemas['chat.restore'].parse(request), operation)
    )
  }
}
