import { Mutex } from "async-mutex";
import browser from "webextension-polyfill";
import {
  ModuleMethodCall,
  PermissionLevel,
  PromptMessage,
  WindowMessage,
} from "../types";
import handleFedimintMessage, { FedimintParams } from "./handlers/fedimint";
import handleNostrMessage, { NostrParams } from "./handlers/nostr";
import handleWeblnMessage, { WeblnParams } from "./handlers/webln";
import { FedimintWallet } from "@fedimint/core-web";
import handleInternalMessage from "./handlers/internal";
import { permissions } from "../lib/constants";

type PromptResolution = { accept: boolean; params?: any };

let openPrompt: {
  resolve: (reason: PromptResolution) => void;
  reject: () => void;
} | null = null;
let promptMutex = new Mutex();
let releasePromptMutex = () => {};
let wallet: FedimintWallet | null = null;
const width = 360;
const height = 400;

async function initWallet() {
  const wal = new FedimintWallet();

  let open = await wal.open("testnet");

  if (!open) {
    await wal.joinFederation(
      "fed11qgqzc2nhwden5te0vejkg6tdd9h8gepwvejkg6tdd9h8garhduhx6at5d9h8jmn9wshxxmmd9uqqzgxg6s3evnr6m9zdxr6hxkdkukexpcs3mn7mj3g5pc5dfh63l4tj6g9zk4er",
      "testnet"
    );
  }

  wallet = wal;
}

browser.runtime.onInstalled.addListener(
  ({ reason }: browser.Runtime.OnInstalledDetailsType) => {
    if (reason === "install") {
      browser.action.openPopup();
    }
  }
);

browser.runtime.onMessage.addListener(
  async (message: WindowMessage, sender) => {
    if (message.ext !== "fedimint-web") return;

    if (!wallet) await initWallet();

    try {
      if (message.type === "prompt") {
        handlePromptMessage(message, sender);
      } else if (message.type === "methodCall") {
        const res = await handleContentScriptMessage(message);

        return { success: true, data: res };
      } else if (message.type === "internalCall") {
        const res = await handleInternalMessage(message);

        return { success: true, data: res };
      }
    } catch (err) {
      return { success: false, message: (err as Error).message };
    }
  }
);

browser.runtime.onMessageExternal.addListener(
  async (message: WindowMessage) => {
    if (message.ext !== "fedimint-web") return;

    try {
      if (message.type === "methodCall") {
        const res = await handleContentScriptMessage(message);

        return { success: true, data: res };
      } else if (message.type === "internalCall") {
        const res = await handleInternalMessage(message);

        return { success: true, data: res };
      }
    } catch (err) {
      return { success: false, message: (err as Error).message };
    }
  }
);

async function handleContentScriptMessage(message: ModuleMethodCall) {
  // acquire mutex here before reading policies
  releasePromptMutex = await promptMutex.acquire();

  let handlerParams = message.params;

  try {
    let qs = new URLSearchParams({
      params: JSON.stringify(message.params),
      module: message.module,
      method: message.method,
    });

    // prompt will be resolved with true or false
    let result = await new Promise<PromptResolution>(
      async (resolve, reject) => {
        const permissionLevel = permissions[message.module][message.method];

        if (permissionLevel === PermissionLevel.None) {
          releasePromptMutex();
          openPrompt = null;
          resolve({ accept: true });

          return;
        }
        // TODO: payment/signature event strictness

        openPrompt = { resolve, reject };

        const win = await browser.windows.create({
          url: `${browser.runtime.getURL("src/prompt.html")}?${qs.toString()}`,
          type: "popup",
          width,
          height,
          top: Math.round(message.window[1]),
          left: Math.round(message.window[0]),
        });

        function listenForClose(id?: number) {
          if (id === win.id) {
            resolve({ accept: false });
            browser.windows.onRemoved.removeListener(listenForClose);
          }
        }

        browser.windows.onRemoved.addListener(listenForClose);
      }
    );

    // TODO: better error handling
    if (!result.accept) throw new Error("denied");

    handlerParams = result.params;
  } catch (err) {
    releasePromptMutex();

    throw new Error((err as Error).message);
  }

  if (message.module === "fedimint") {
    return await handleFedimintMessage(
      {
        method: message.method as FedimintParams["method"],
        params: handlerParams,
      },
      wallet!
    );
  } else if (message.module === "nostr") {
    return await handleNostrMessage({
      method: message.method as NostrParams["method"],
      params: handlerParams,
    });
  } else if (message.module === "webln") {
    return await handleWeblnMessage(
      {
        method: message.method as WeblnParams["method"],
        params: handlerParams,
      },
      wallet!
    );
  }
}

async function handlePromptMessage(message: PromptMessage, sender: any) {
  openPrompt?.resolve?.({ accept: true, params: message.params });

  openPrompt = null;

  releasePromptMutex();

  if (sender) {
    browser.windows.remove(sender.tab.windowId);
  }
}
