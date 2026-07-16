import { EnvironmentId, MessageId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { type QueuedThreadMessage, useMessageQueueStore } from "./messageQueueStore";

const threadRef = scopeThreadRef(
  EnvironmentId.make("local"),
  ThreadId.make("thread-message-queue"),
);

const queuedMessage = (id: string, text: string): QueuedThreadMessage => ({
  id: MessageId.make(id),
  text,
  attachments: [],
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.4",
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  queuedAt: "2026-07-16T12:00:00.000Z",
});

describe("messageQueueStore", () => {
  beforeEach(() => {
    useMessageQueueStore.setState({ messagesByThreadKey: {} });
  });

  it("keeps queued messages in insertion order", () => {
    const store = useMessageQueueStore.getState();
    store.enqueue(threadRef, queuedMessage("message-1", "first"));
    store.enqueue(threadRef, queuedMessage("message-2", "second"));

    expect(
      useMessageQueueStore
        .getState()
        .messagesByThreadKey[scopedThreadKey(threadRef)]?.map((message) => message.text),
    ).toEqual(["first", "second"]);
  });

  it("removes only the selected queued message", () => {
    const store = useMessageQueueStore.getState();
    store.enqueue(threadRef, queuedMessage("message-1", "first"));
    store.enqueue(threadRef, queuedMessage("message-2", "second"));
    store.remove(threadRef, MessageId.make("message-1"));

    expect(
      useMessageQueueStore
        .getState()
        .messagesByThreadKey[scopedThreadKey(threadRef)]?.map((message) => message.text),
    ).toEqual(["second"]);
  });
});
