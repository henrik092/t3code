import {
  type ModelSelection,
  type MessageId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ScopedThreadRef,
  type UploadChatAttachment,
} from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { useShallow } from "zustand/react/shallow";

import { createMemoryStorage } from "./lib/storage";

export const MESSAGE_QUEUE_STORAGE_KEY = "t3code:message-queue:v1";

export interface QueuedThreadMessage {
  readonly id: MessageId;
  readonly text: string;
  readonly attachments: ReadonlyArray<UploadChatAttachment>;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly queuedAt: string;
}

interface MessageQueueStoreState {
  readonly messagesByThreadKey: Record<string, ReadonlyArray<QueuedThreadMessage>>;
  readonly enqueue: (threadRef: ScopedThreadRef, message: QueuedThreadMessage) => void;
  readonly remove: (threadRef: ScopedThreadRef, messageId: MessageId) => void;
}

const storage = typeof localStorage !== "undefined" ? localStorage : createMemoryStorage();

export const useMessageQueueStore = create<MessageQueueStoreState>()(
  persist(
    (set) => ({
      messagesByThreadKey: {},
      enqueue: (threadRef, message) => {
        const threadKey = scopedThreadKey(threadRef);
        set((state) => ({
          messagesByThreadKey: {
            ...state.messagesByThreadKey,
            [threadKey]: [...(state.messagesByThreadKey[threadKey] ?? []), message],
          },
        }));
      },
      remove: (threadRef, messageId) => {
        const threadKey = scopedThreadKey(threadRef);
        set((state) => {
          const current = state.messagesByThreadKey[threadKey] ?? [];
          const nextMessages = current.filter((message) => message.id !== messageId);
          if (nextMessages.length === current.length) {
            return state;
          }
          const messagesByThreadKey = { ...state.messagesByThreadKey };
          if (nextMessages.length === 0) {
            delete messagesByThreadKey[threadKey];
          } else {
            messagesByThreadKey[threadKey] = nextMessages;
          }
          return { messagesByThreadKey };
        });
      },
    }),
    {
      name: MESSAGE_QUEUE_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => storage),
      partialize: (state) => ({ messagesByThreadKey: state.messagesByThreadKey }),
    },
  ),
);

export function useQueuedThreadMessages(
  threadRef: ScopedThreadRef | null,
): ReadonlyArray<QueuedThreadMessage> {
  const threadKey = threadRef ? scopedThreadKey(threadRef) : null;
  return useMessageQueueStore(
    useShallow((state) => (threadKey === null ? [] : (state.messagesByThreadKey[threadKey] ?? []))),
  );
}
