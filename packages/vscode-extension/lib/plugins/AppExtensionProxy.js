export class AppExtensionProxy {
  scope;
  listeners = new Map();
  devtoolsAgent = undefined;

  constructor(scope) {
    this.scope = scope;
    const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (hook.reactDevtoolsAgent) {
      this.setDevtoolsAgent(hook.reactDevtoolsAgent);
    } else {
      hook.on("react-devtools", this.setDevtoolsAgent);
    }
  }

  handleMessages = (data) => {
    if (data.scope === this.scope) {
      const listeners = this.listeners.get(data.type) || [];
      listeners.forEach((listener) => listener(data.data));
    }
  };

  setDevtoolsAgent = (agent) => {
    if (!agent) {
      return;
    }
    this.clearDevToolsAgent();
    this.devtoolsAgent = agent;
    this.devtoolsAgent._bridge.addListener("RNIDE_pluginMessage", this.handleMessages);
  };

  clearDevToolsAgent() {
    if (!this.devtoolsAgent) {
      return;
    }
    this.devtoolsAgent._bridge.removeListener("RNIDE_pluginMessage", this.handleMessages);
    this.devtoolsAgent = undefined;
  }

  sendMessage(type, data) {
    if (!this.devtoolsAgent) {
      return;
    }

    this.devtoolsAgent._bridge.send("RNIDE_pluginMessage", {
      scope: this.scope,
      type,
      data,
    });
  }

  addMessageListener(type, listener) {
    const currentListeners = this.listeners.get(type) || [];
    this.listeners.set(type, [...currentListeners, listener]);
  }

  removeMessageListener(type, listener) {
    const currentListeners = this.listeners.get(type) || [];
    const filteredListeners = currentListeners.filter((l) => l !== listener);
    this.listeners.set(type, filteredListeners);
  }

  closeAsync() {
    const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    hook.off("react-devtools", this.setDevtoolsAgent);
    this.clearDevToolsAgent();
    this.listeners.clear();
  }
}
