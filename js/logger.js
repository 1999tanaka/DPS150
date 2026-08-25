const CSV_HEADERS = [
  "timestamp",
  "elapsed_s",
  "A",
  "T_s",
  "cycle",
  "command_v",
  "measured_v",
  "measured_a",
  "measured_w",
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
      numeric(record.elapsedSeconds, 3),
      numeric(record.A, 3),
      numeric(record.T, 3),
      record.cycle,
      numeric(record.commandVoltage, 4),
      numeric(record.measuredVoltage, 4),
      numeric(record.measuredCurrent, 4),
      numeric(record.measuredPower, 4),
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
      elapsedSeconds: sample.elapsedSeconds,
      A: sample.A,
      T: sample.T,
      cycle: sample.cycle,
      commandVoltage: sample.commandVoltage,
      measuredVoltage: sample.measuredVoltage,
      measuredCurrent: sample.measuredCurrent,
      measuredPower: sample.measuredPower,
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
