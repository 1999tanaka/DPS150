const CSV_HEADERS = [
  "timestamp",
  "record_type",
  "elapsed_s",
  "i",
  "Vmax",
  "Amax",
  "control_cycle_ms",
  "command_v",
  "current_limit_a",
  "measured_v",
  "measured_a",
  "measured_w",
  "measurement_elapsed_s",
  "measurement_sequence",
  "mode",
  "protection",
  "output_on",
];

function csvEscape(value) {
  if (value == null) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function numeric(value, digits) {
  return Number.isFinite(value) ? value.toFixed(digits) : "";
}

export function recordsToCsv(records) {
  const lines = [CSV_HEADERS.join(",")];
  for (const record of records) {
    lines.push([
      record.timestamp,
      record.recordType,
      numeric(record.elapsedSeconds, 3),
      Number.isInteger(record.i) ? record.i : "",
      numeric(record.voltageMax, 4),
      numeric(record.currentMax, 4),
      numeric(record.controlCycleMs, 0),
      numeric(record.commandVoltage, 4),
      numeric(record.commandCurrent, 4),
      numeric(record.measuredVoltage, 4),
      numeric(record.measuredCurrent, 4),
      numeric(record.measuredPower, 4),
      numeric(record.measurementElapsedSeconds, 3),
      Number.isFinite(record.measurementSequence) ? record.measurementSequence : "",
      record.mode,
      record.protectionState || "OK",
      record.outputEnabled ? 1 : 0,
    ].map(csvEscape).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

function timestampForFilename(date = new Date()) {
  const parts = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ];
  const time = [
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    String(date.getSeconds()).padStart(2, "0"),
  ].join("");
  return `${parts.join("-")}_${time}`;
}

export class ExperimentLogger {
  constructor({ maxRecords = 250_000 } = {}) {
    this.maxRecords = maxRecords;
    this.records = [];
    this.truncated = false;
  }

  clear() {
    this.records.length = 0;
    this.truncated = false;
  }

  add(sample) {
    if (this.records.length >= this.maxRecords) {
      this.truncated = true;
      return false;
    }
    this.records.push({
      timestamp: new Date().toISOString(),
      recordType: sample.recordType ?? "command",
      elapsedSeconds: sample.elapsedSeconds,
      i: sample.i,
      voltageMax: sample.voltageMax,
      currentMax: sample.currentMax,
      controlCycleMs: sample.controlCycleMs,
      commandVoltage: sample.commandVoltage,
      commandCurrent: sample.commandCurrent,
      measuredVoltage: sample.measuredVoltage,
      measuredCurrent: sample.measuredCurrent,
      measuredPower: sample.measuredPower,
      measurementElapsedSeconds: sample.measurementElapsedSeconds,
      measurementSequence: sample.measurementSequence,
      mode: sample.mode ?? "",
      protectionState: sample.protectionState ?? "",
      outputEnabled: Boolean(sample.outputEnabled),
    });
    return true;
  }

  get size() {
    return this.records.length;
  }

  toCsv() {
    return recordsToCsv(this.records);
  }

  download(filename = `dps150_${timestampForFilename()}.csv`) {
    if (this.records.length === 0) return false;
    const blob = new Blob(["\ufeff", this.toCsv()], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
    return true;
  }
}
