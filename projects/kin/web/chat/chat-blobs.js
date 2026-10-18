// Chat content on this device (#110): sealing, keeping, fetching on demand
// and deleting message blobs. The chat room (#111) drives it.
//
// - Sending seals the text under a new key and keeps the blob locally; the
//   upload goes once the chat event is stored (the outbox retries it).
// - Opening uses the local copy, else fetches the blob from the service as
//   the message scrolls into view, checks it against its reference, keeps
//   it and decrypts it.
// - Deleting follows the engine's retired list (kin_chat_page, KCHP): every
//   device deletes those blobs locally and remembers that it did; the
//   author's device, or an admin's for a removal, also asks the service to
//   delete them. A device that was offline catches up the same way the
//   next time it reads a page, so deletion reaches it once it syncs.
import { ChatBlobError, openChatText, sealChatText } from "./chat-blob-crypto.js";

export class ChatBlobs {
  constructor({ store, client }) {
    this.store = store;
    this.client = client;
  }

  /** Seals a text message and keeps its blob. Returns { ref, key } for the
   * chat event; call upload(ref) once the event is stored. */
  async seal(text) {
    const { ref, key, ciphertext } = await sealChatText(text);
    await this.store.put(ref, ciphertext);
    return { ref, key };
  }

  /** Uploads a kept blob. A blob deleted meanwhile is not uploaded; one
   * deleted while its upload was in flight is retired at once after it. */
  async upload(ref) {
    const ciphertext = await this.store.get(ref);
    if (!ciphertext) return { uploaded: false };
    try {
      await this.client.upload(ref, ciphertext);
    } catch (error) {
      // The service already has a deletion for it: nothing to send.
      if (error?.code === "chat_blob_deleted") return { uploaded: false };
      throw error;
    }
    if (await this.store.isRetired(ref)) {
      await this.client.retire([ref]);
      return { uploaded: false };
    }
    return { uploaded: true };
  }

  /**
   * A text message's content: { text }, { deleted: true } when its blob was
   * deleted (here or on the service), or { pending: true } when the
   * author's device hasn't uploaded it yet.
   */
  async openText({ ref, key }) {
    if (await this.store.isRetired(ref)) return { deleted: true };
    let ciphertext = await this.store.get(ref);
    if (!ciphertext) {
      const fetched = await this.client.download(ref);
      if (fetched.deleted) {
        await this.store.retire([ref]);
        return { deleted: true };
      }
      if (fetched.missing) return { pending: true };
      ciphertext = fetched.ciphertext;
      // openChatText checks the bytes against the reference before
      // anything is kept.
      const text = await openChatText(ciphertext, { ref, key });
      await this.store.put(ref, ciphertext);
      return { text };
    }
    return { text: await openChatText(ciphertext, { ref, key }) };
  }

  /**
   * Applies a page's retired blobs: deletes them on this device, then asks
   * the service to delete those in `remote` (the ones this member uploaded,
   * or every one for an admin's removal). Local deletion happens first and
   * stands even if the service can't be reached; calling again later
   * retries the service, which ignores blobs already deleted.
   */
  async retire(retired, { remote = [] } = {}) {
    const deleted = await this.store.retire(retired);
    let remoteError = null;
    if (remote.length) {
      try {
        await this.client.retire(remote);
      } catch (error) {
        if (!(error instanceof ChatBlobError)) throw error;
        remoteError = error;
      }
    }
    return { deleted, remoteError };
  }
}
