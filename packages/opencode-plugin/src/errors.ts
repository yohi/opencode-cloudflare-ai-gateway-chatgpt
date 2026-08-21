export class PluginConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginConfigurationError";
  }
}

export class UnsupportedOpenCodeVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedOpenCodeVersionError";
  }
}
