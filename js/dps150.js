// DPS-150 register map and framing are based on the reverse-engineered,
// MIT-licensed implementation by cho45. See THIRD_PARTY_NOTICES.md.

const HEADER_FROM_DEVICE = 0xf0;
const HEADER_TO_DEVICE = 0xf1;

const COMMAND_GET = 0xa1;
const COMMAND_BAUD = 0xb0;
const COMMAND_SET = 0xb1;
const COMMAND_SESSION = 0xc1;

const REGISTER = Object.freeze({
  INPUT_VOLTAGE: 0xc0,
  SET_VOLTAGE: 0xc1,
  SET_CURRENT: 0xc2,
  MEASUREMENT: 0xc3,
  TEMPERATURE: 0xc4,
  OUTPUT_ENABLE: 0xdb,
  PROTECTION: 0xdc,
  MODE: 0xdd,
  MODEL_NAME: 0xde,
  HARDWARE_VERSION: 0xdf,
  FIRMWARE_VERSION: 0xe0,
  MAX_VOLTAGE: 0xe2,
  MAX_CURRENT: 0xe3,
  ALL: 0xff,
});

const PROTECTION_STATES = ["", "OVP", "OCP", "OPP", "OTP", "LVP", "REP"];
const DEFAULT_WRITE_TIMEOUT_MS = 1_500;
const DEFAULT_RESPONSE_TIMEOUT_MS = 3_000;
const DEFAULT_COMMAND_SETTLE_MS = 60;
const DEFAULT_OUTPUT_CONFIRM_TIMEOUT_MS = 750;

export class DPS150Error extends Error {
  constructor(message, code = "DPS150_ERROR", cause) {
    super(message, { cause });
    this.name = "DPS150Error";
    this.code = code;
  }
}

function normalizeBytes(data) {
  if (data == null) return new Uint8Array();
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof data === "number") return Uint8Array.of(data);
  return Uint8Array.from(data);
}

export function calculateChecksum(register, data = []) {
  const bytes = normalizeBytes(data);
  let checksum = (register + bytes.length) & 0xff;
  for (const byte of bytes) checksum = (checksum + byte) & 0xff;
  return checksum;
}

export function buildPacket(command, register, data = [], header = HEADER_TO_DEVICE) {
  const bytes = normalizeBytes(data);
  if (bytes.length > 255) {
    throw new RangeError("DPS-150 packet payload must be 255 bytes or fewer.");
  }
  const packet = new Uint8Array(bytes.length + 5);
  packet[0] = header;
  packet[1] = command;
  packet[2] = register;
  packet[3] = bytes.length;
  packet.set(bytes, 4);
  packet[packet.length - 1] = calculateChecksum(register, bytes);
  return packet;
}

export function encodeFloat32(value) {
  if (!Number.isFinite(value)) {
    throw new TypeError("DPS-150 float value must be finite.");
  }
  const buffer = new ArrayBuffer(4);
  new DataView(buffer).setFloat32(0, value, true);
  return new Uint8Array(buffer);
}

export class PacketParser {
  constructor() {
    this.buffer = new Uint8Array();
    this.checksumErrors = 0;
  }

  reset() {
    this.buffer = new Uint8Array();
    this.checksumErrors = 0;
  }

  push(chunk) {
    const incoming = normalizeBytes(chunk);
    const combined = new Uint8Array(this.buffer.length + incoming.length);
    combined.set(this.buffer);
    combined.set(incoming, this.buffer.length);
    this.buffer = combined;

    const frames = [];
    while (this.buffer.length >= 5) {
      const start = this.buffer.indexOf(HEADER_FROM_DEVICE);
      if (start < 0) {
        this.buffer = new Uint8Array();
        break;
      }
      if (start > 0) this.buffer = this.buffer.slice(start);
      if (this.buffer.length < 5) break;

      const dataLength = this.buffer[3];
      const frameLength = dataLength + 5;
      if (this.buffer.length < frameLength) break;

      const register = this.buffer[2];
      const data = this.buffer.slice(4, 4 + dataLength);
      const receivedChecksum = this.buffer[frameLength - 1];
      const expectedChecksum = calculateChecksum(register, data);

      if (receivedChecksum !== expectedChecksum) {
        this.checksumErrors += 1;
        this.buffer = this.buffer.slice(1);
        continue;
      }

      frames.push({
        header: this.buffer[0],
        command: this.buffer[1],
        register,
        data,
        checksum: receivedChecksum,
      });
      this.buffer = this.buffer.slice(frameLength);
    }
    return frames;
  }
}

function dataViewFor(data) {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

function readFloat(data, offset = 0) {
  if (data.byteLength < offset + 4) return undefined;
  return dataViewFor(data).getFloat32(offset, true);
}

function readString(data) {
  return new TextDecoder().decode(data).replace(/\0+$/g, "").trim();
}

function monotonicNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class DPS150 extends EventTarget {
  constructor(options = {}) {
    super();
    this.port = null;
    this.reader = null;
    this.readTask = null;
    this.parser = new PacketParser();
    this.writeTimeoutMs = options.writeTimeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS;
    this.responseTimeoutMs = options.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;
    this.commandSettleMs = options.commandSettleMs ?? DEFAULT_COMMAND_SETTLE_MS;
    this.outputConfirmTimeoutMs = options.outputConfirmTimeoutMs ?? DEFAULT_OUTPUT_CONFIRM_TIMEOUT_MS;
    this.writeChain = Promise.resolve();
    this.registerVersions = new Map();
    this.lastTelemetryAt = 0;
    this.lastMeasurementAt = 0;
    this.smoothedMeasurementIntervalMs = null;
    this.closing = false;
    this.state = {
      connected: false,
      outputEnabled: false,
      modelName: "DPS-150",
      hardwareVersion: "",
      firmwareVersion: "",
      inputVoltage: null,
      setVoltage: null,
      setCurrent: null,
      measuredVoltage: null,
      measuredCurrent: null,
      measuredPower: null,
      temperature: null,
      protectionState: "",
      mode: "",
      maxVoltage: null,
      maxCurrent: null,
      measurementSequence: 0,
      measurementRateHz: null,
      measurementReceivedAtMs: null,
    };
    this.handleSerialDisconnect = this.handleSerialDisconnect.bind(this);
  }

  static get isSupported() {
    return Boolean(globalThis.isSecureContext && globalThis.navigator?.serial);
  }

  get connected() {
    return this.state.connected && Boolean(this.port?.readable && this.port?.writable);
  }

  get telemetryAgeMs() {
    return this.lastTelemetryAt ? monotonicNow() - this.lastTelemetryAt : Number.POSITIVE_INFINITY;
  }

  get measurementAgeMs() {
    return this.lastMeasurementAt ? monotonicNow() - this.lastMeasurementAt : Number.POSITIVE_INFINITY;
  }

  getState() {
    return {
      ...this.state,
      telemetryAgeMs: this.telemetryAgeMs,
      measurementAgeMs: this.measurementAgeMs,
    };
  }

  async connect() {
    if (this.connected) return this.getState();
    if (!DPS150.isSupported) {
      throw new DPS150Error(
        "Web Serialを利用できません。HTTPS上のChromeまたはEdgeで開いてください。",
        "UNSUPPORTED",
      );
    }

    this.closing = false;
    this.parser.reset();
    this.registerVersions.clear();
    this.lastMeasurementAt = 0;
    this.smoothedMeasurementIntervalMs = null;
    this.state.measurementSequence = 0;
    this.state.measurementRateHz = null;
    this.state.measurementReceivedAtMs = null;
    const port = await navigator.serial.requestPort();
    this.port = port;
    navigator.serial.addEventListener("disconnect", this.handleSerialDisconnect);

    try {
      await port.open({
        baudRate: 115200,
        bufferSize: 4096,
        dataBits: 8,
        stopBits: 1,
        parity: "none",
        flowControl: "hardware",
      });

      this.readTask = this.readLoop();
      const responseBaseline = this.lastTelemetryAt;
      await this.sendCommand(COMMAND_SESSION, 0x00, 0x01);
      await delay(this.commandSettleMs);
      await this.sendCommand(COMMAND_BAUD, 0x00, 0x05);
      await delay(this.commandSettleMs);
      await this.requestRegister(REGISTER.MODEL_NAME);
      await delay(this.commandSettleMs);
      await this.requestRegister(REGISTER.HARDWARE_VERSION);
      await delay(this.commandSettleMs);
      await this.requestRegister(REGISTER.FIRMWARE_VERSION);
      await delay(this.commandSettleMs);
      await this.requestRegister(REGISTER.ALL);
      await this.waitForTelemetry(this.responseTimeoutMs, responseBaseline);

      this.state.connected = true;
      this.publishState("connected");
      return this.getState();
    } catch (error) {
      await this.closePortOnly();
      throw error instanceof DPS150Error
        ? error
        : new DPS150Error("DPS-150から応答がありません。選択したポートとUSB接続を確認してください。", "CONNECT_FAILED", error);
    }
  }

  async disconnect({ turnOutputOff = true } = {}) {
    if (!this.port) return;
    this.closing = true;

    if (turnOutputOff && this.port.writable) {
      try {
        await this.outputOff();
      } catch {
        // Continue closing even if the emergency OFF command cannot be written.
      }
    }
    if (this.port?.writable) {
      try {
        await this.sendCommand(COMMAND_SESSION, 0x00, 0x00);
      } catch {
        // The cable may already be gone.
      }
    }

    await this.closePortOnly();
    this.state.connected = false;
    this.state.outputEnabled = false;
    this.publishState("disconnected");
    this.dispatchEvent(new CustomEvent("disconnect", { detail: { expected: true } }));
  }

  async closePortOnly() {
    const port = this.port;
    if (!port) return;
    navigator.serial?.removeEventListener?.("disconnect", this.handleSerialDisconnect);

    try {
      await this.reader?.cancel();
    } catch {
      // Reader may already be closed after a physical disconnect.
    }
    try {
      await this.readTask;
    } catch {
      // The read loop reports unexpected errors separately.
    }
    try {
      if (port.readable || port.writable) await port.close();
    } catch {
      // A physically removed port can reject close().
    }

    this.reader = null;
    this.readTask = null;
    this.port = null;
    this.closing = false;
  }

  handleSerialDisconnect(event) {
    const disconnectedPort = event.port ?? event.target;
    if (disconnectedPort !== this.port || this.closing) return;

    const error = new DPS150Error("USB接続が切断されました。", "USB_DISCONNECTED");
    this.closing = true;
    this.state.connected = false;
    this.state.outputEnabled = false;
    this.publishState("disconnected");
    this.dispatchEvent(new CustomEvent("disconnect", { detail: { expected: false, error } }));
    void this.closePortOnly();
  }

  async readLoop() {
    try {
      while (this.port?.readable) {
        const reader = this.port.readable.getReader();
        this.reader = reader;
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) return;
            for (const frame of this.parser.push(value)) this.handleFrame(frame);
          }
        } finally {
          reader.releaseLock();
          if (this.reader === reader) this.reader = null;
        }
      }
    } catch (error) {
      if (!this.closing) {
        const communicationError = new DPS150Error("シリアル受信中にエラーが発生しました。", "READ_FAILED", error);
        this.state.connected = false;
        this.publishState("error");
        this.dispatchEvent(new CustomEvent("error", { detail: { error: communicationError } }));
      }
    }
  }

  handleFrame(frame) {
    if (frame.command !== COMMAND_GET) return;
    const { register, data } = frame;
    this.registerVersions.set(register, (this.registerVersions.get(register) ?? 0) + 1);
    const update = {};

    switch (register) {
      case REGISTER.INPUT_VOLTAGE:
        update.inputVoltage = readFloat(data);
        break;
      case REGISTER.SET_VOLTAGE:
        update.setVoltage = readFloat(data);
        break;
      case REGISTER.SET_CURRENT:
        update.setCurrent = readFloat(data);
        break;
      case REGISTER.MEASUREMENT:
        update.measuredVoltage = readFloat(data, 0);
        update.measuredCurrent = readFloat(data, 4);
        update.measuredPower = readFloat(data, 8);
        break;
      case REGISTER.TEMPERATURE:
        update.temperature = readFloat(data);
        break;
      case REGISTER.OUTPUT_ENABLE:
        update.outputEnabled = data[0] === 1;
        break;
      case REGISTER.PROTECTION:
        update.protectionState = PROTECTION_STATES[data[0]] ?? `UNKNOWN(${data[0]})`;
        break;
      case REGISTER.MODE:
        update.mode = data[0] === 0 ? "CC" : "CV";
        break;
      case REGISTER.MODEL_NAME:
        update.modelName = readString(data) || "DPS-150";
        break;
      case REGISTER.HARDWARE_VERSION:
        update.hardwareVersion = readString(data);
        break;
      case REGISTER.FIRMWARE_VERSION:
        update.firmwareVersion = readString(data);
        break;
      case REGISTER.MAX_VOLTAGE:
        update.maxVoltage = readFloat(data);
        break;
      case REGISTER.MAX_CURRENT:
        update.maxCurrent = readFloat(data);
        break;
      case REGISTER.ALL:
        Object.assign(update, this.parseFullState(data));
        break;
      default:
        break;
    }

    for (const key of Object.keys(update)) {
      if (update[key] === undefined || Number.isNaN(update[key])) delete update[key];
    }
    const receivedAt = monotonicNow();
    if ((register === REGISTER.MEASUREMENT || register === REGISTER.ALL)
      && Number.isFinite(update.measuredVoltage)
      && Number.isFinite(update.measuredCurrent)) {
      if (this.lastMeasurementAt > 0) {
        const intervalMs = receivedAt - this.lastMeasurementAt;
        this.smoothedMeasurementIntervalMs = this.smoothedMeasurementIntervalMs == null
          ? intervalMs
          : this.smoothedMeasurementIntervalMs * 0.75 + intervalMs * 0.25;
      }
      this.lastMeasurementAt = receivedAt;
      update.measurementSequence = (this.state.measurementSequence ?? 0) + 1;
      update.measurementRateHz = this.smoothedMeasurementIntervalMs > 0
        ? 1_000 / this.smoothedMeasurementIntervalMs
        : null;
      update.measurementReceivedAtMs = receivedAt;
    }
    this.lastTelemetryAt = receivedAt;
    Object.assign(this.state, update);
    this.dispatchEvent(new CustomEvent("telemetry", {
      detail: { state: this.getState(), update, register },
    }));
  }

  parseFullState(data) {
    if (data.byteLength < 110) return {};
    const update = {
      inputVoltage: readFloat(data, 0),
      setVoltage: readFloat(data, 4),
      setCurrent: readFloat(data, 8),
      measuredVoltage: readFloat(data, 12),
      measuredCurrent: readFloat(data, 16),
      measuredPower: readFloat(data, 20),
      temperature: readFloat(data, 24),
      outputEnabled: data[107] === 1,
      protectionState: PROTECTION_STATES[data[108]] ?? `UNKNOWN(${data[108]})`,
      mode: data[109] === 0 ? "CC" : "CV",
    };
    if (data.byteLength >= 119) {
      update.maxVoltage = readFloat(data, 111);
      update.maxCurrent = readFloat(data, 115);
    }
    return update;
  }

  waitForTelemetry(timeoutMs = this.responseTimeoutMs, after = this.lastTelemetryAt) {
    if (this.lastTelemetryAt > after) return Promise.resolve(this.getState());
    return new Promise((resolve, reject) => {
      const onTelemetry = () => {
        if (this.lastTelemetryAt <= after) return;
        cleanup();
        resolve(this.getState());
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new DPS150Error("DPS-150応答タイムアウト。", "RESPONSE_TIMEOUT"));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.removeEventListener("telemetry", onTelemetry);
      };
      this.addEventListener("telemetry", onTelemetry);
    });
  }

  waitForRegister(register, afterVersion, timeoutMs = this.outputConfirmTimeoutMs) {
    if ((this.registerVersions.get(register) ?? 0) > afterVersion) {
      return Promise.resolve(this.getState());
    }
    return new Promise((resolve, reject) => {
      const onTelemetry = (event) => {
        if (event.detail?.register !== register) return;
        if ((this.registerVersions.get(register) ?? 0) <= afterVersion) return;
        cleanup();
        resolve(this.getState());
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new DPS150Error(
          `DPS-150 register 0x${register.toString(16).toUpperCase()} response timeout.`,
          "REGISTER_TIMEOUT",
        ));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.removeEventListener("telemetry", onTelemetry);
      };
      this.addEventListener("telemetry", onTelemetry);
    });
  }

  publishState(reason) {
    this.dispatchEvent(new CustomEvent("statechange", {
      detail: { state: this.getState(), reason },
    }));
  }

  async sendCommand(command, register, data = []) {
    if (!this.port?.writable) {
      throw new DPS150Error("DPS-150が接続されていません。", "NOT_CONNECTED");
    }
    const packet = buildPacket(command, register, data);
    const operation = this.writeChain
      .catch(() => undefined)
      .then(() => this.writePacket(packet));
    this.writeChain = operation;
    return operation;
  }

  async writePacket(packet) {
    const writer = this.port?.writable?.getWriter();
    if (!writer) throw new DPS150Error("シリアル送信ポートを利用できません。", "WRITE_UNAVAILABLE");

    let timeoutId;
    let didTimeout = false;
    const timeoutError = new DPS150Error("DPS-150への送信がタイムアウトしました。", "WRITE_TIMEOUT");
    try {
      const timeout = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          didTimeout = true;
          reject(timeoutError);
        }, this.writeTimeoutMs);
      });
      await Promise.race([writer.write(packet), timeout]);
    } catch (error) {
      if (didTimeout) {
        try {
          await writer.abort(timeoutError);
        } catch {
          // The stream may already be gone.
        }
      }
      throw error instanceof DPS150Error
        ? error
        : new DPS150Error("DPS-150への送信に失敗しました。", "WRITE_FAILED", error);
    } finally {
      clearTimeout(timeoutId);
      try {
        writer.releaseLock();
      } catch {
        // Aborted streams can already have released the lock.
      }
    }
  }

  requestRegister(register) {
    return this.sendCommand(COMMAND_GET, register, 0x00);
  }

  requestMeasurements() {
    return this.requestRegister(REGISTER.MEASUREMENT);
  }

  async getStatus() {
    const baseline = this.lastTelemetryAt;
    await this.requestRegister(REGISTER.ALL);
    return this.waitForTelemetry(this.responseTimeoutMs, baseline);
  }

  async setVoltage(voltage) {
    if (!Number.isFinite(voltage) || voltage < 0 || voltage > 30) {
      throw new DPS150Error("不正な電圧設定値です。", "INVALID_VOLTAGE");
    }
    await this.sendCommand(COMMAND_SET, REGISTER.SET_VOLTAGE, encodeFloat32(voltage));
    this.state.setVoltage = voltage;
    this.publishState("voltage-set");
  }

  async setCurrent(current) {
    if (!Number.isFinite(current) || current <= 0 || current > 5.1) {
      throw new DPS150Error("不正なCurrent Limitです。", "INVALID_CURRENT");
    }
    await this.sendCommand(COMMAND_SET, REGISTER.SET_CURRENT, encodeFloat32(current));
    this.state.setCurrent = current;
    this.publishState("current-set");
  }

  async setOutputEnabled(enabled) {
    const value = enabled ? 0x01 : 0x00;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const setVersion = this.registerVersions.get(REGISTER.OUTPUT_ENABLE) ?? 0;
      await this.sendCommand(COMMAND_SET, REGISTER.OUTPUT_ENABLE, value);
      try {
        await this.waitForRegister(REGISTER.OUTPUT_ENABLE, setVersion);
      } catch {
        // Some firmware does not echo a SET. Verify with an explicit read below.
      }
      if (this.state.outputEnabled === enabled
        && (this.registerVersions.get(REGISTER.OUTPUT_ENABLE) ?? 0) > setVersion) {
        this.publishState(enabled ? "output-on-confirmed" : "output-off-confirmed");
        return;
      }

      await delay(this.commandSettleMs);
      const readVersion = this.registerVersions.get(REGISTER.OUTPUT_ENABLE) ?? 0;
      await this.requestRegister(REGISTER.OUTPUT_ENABLE);
      try {
        await this.waitForRegister(REGISTER.OUTPUT_ENABLE, readVersion);
      } catch {
        // Retry the SET once when neither the change event nor explicit read confirms it.
      }
      if (this.state.outputEnabled === enabled
        && (this.registerVersions.get(REGISTER.OUTPUT_ENABLE) ?? 0) > readVersion) {
        this.publishState(enabled ? "output-on-confirmed" : "output-off-confirmed");
        return;
      }
      if (attempt === 0) await delay(this.commandSettleMs);
    }

    throw new DPS150Error(
      enabled
        ? "DPS-150がOUTPUT ONを確認できませんでした。"
        : "DPS-150がOUTPUT OFFを確認できませんでした。",
      enabled ? "OUTPUT_ON_NOT_CONFIRMED" : "OUTPUT_OFF_NOT_CONFIRMED",
    );
  }

  outputOn() {
    return this.setOutputEnabled(true);
  }

  async outputOff() {
    if (!this.port?.writable) {
      this.state.outputEnabled = false;
      this.publishState("output-off-unavailable");
      return;
    }
    await this.setOutputEnabled(false);
  }
}

export { REGISTER };
