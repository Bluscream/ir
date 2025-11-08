(() => {
  const DEFAULTS = {
    irsockEndpoint: "https://irsock.flirc.io:3030/endpoint",
    defaultFrequency: 38000,
    prontoClock: 0.241246,
  };

  const params = new URLSearchParams(window.location.search);

  const config = {
    irsockEndpoint: getStringParam(params, "endpoint", DEFAULTS.irsockEndpoint),
    defaultFrequency: getNumberParam(
      params,
      "defaultFrequency",
      DEFAULTS.defaultFrequency
    ),
    prontoClock: getNumberParam(
      params,
      "prontoClock",
      DEFAULTS.prontoClock,
      (value) => value > 0
    ),
  };

  const elements = {
    inputs: Array.from(document.querySelectorAll("[data-format]")),
    inputMap: new Map(),
    messages: new Map(),
    frequency: document.getElementById("frequencyInput"),
    copyButton: document.getElementById("copyAllButton"),
    clearButton: document.getElementById("clearButton"),
    metadata: document.getElementById("metadataOutput"),
    jsonOutput: document.getElementById("jsonOutput"),
    settings: {
      endpoint: document.getElementById("endpointInput"),
      defaultFrequency: document.getElementById("defaultFrequencyInput"),
      prontoClock: document.getElementById("prontoClockInput"),
    },
  };

  elements.inputs.forEach((input) => {
    const key = input.dataset.format;
    elements.inputMap.set(key, input);
    const messageNode = document.querySelector(`[data-message-for="${key}"]`);
    if (messageNode) {
      elements.messages.set(key, messageNode);
    }
  });

  elements.messages.set(
    "frequency",
    document.querySelector('[data-message-for="frequency"]')
  );
  elements.messages.set(
    "endpoint",
    document.querySelector('[data-message-for="endpoint"]')
  );
  elements.messages.set(
    "defaultFrequency",
    document.querySelector('[data-message-for="defaultFrequency"]')
  );
  elements.messages.set(
    "prontoClock",
    document.querySelector('[data-message-for="prontoClock"]')
  );

  const state = {
    timings: [],
    sourceFormat: null,
    leadingMark: true,
    frequencyHz: config.defaultFrequency,
    irsock: null,
    lastError: null,
  };

  let isUpdating = false;
  let metadataTimer;

  const formatHandlers = {
    raw: {
      parse(value) {
        const matches = value.match(/[+-]?\d+(?:\.\d+)?/g);
        if (!matches) {
          throw new Error("No pulse widths found.");
        }
        const leadingMark = value.trim().startsWith("-") ? false : true;
        const timings = normaliseTimings(
          matches.map((token) => parseFloat(token))
        );
        if (!timings.length) {
          throw new Error("No valid durations in raw string.");
        }
        return { timings, leadingMark };
      },
      format(currentState) {
        return buildSignedSequence(
          currentState.timings,
          currentState.leadingMark
        );
      },
    },
    csv: {
      parse(value) {
        const numbers = value
          .split(/[\s,]+/)
          .map((item) => item.trim())
          .filter(Boolean)
          .map((item) => parseFloat(item));
        if (!numbers.length) {
          throw new Error("CSV input must contain numbers.");
        }
        const timings = numbers[0] === 0 ? numbers.slice(1) : numbers;
        const cleaned = normaliseTimings(timings);
        if (!cleaned.length) {
          throw new Error("No valid durations in CSV string.");
        }
        return { timings: cleaned };
      },
      format(currentState) {
        return ["0"].concat(currentState.timings).join(",");
      },
    },
    pronto: {
      parse(value) {
        const words = value
          .trim()
          .split(/\s+/)
          .map((word) => word.toLowerCase());
        if (words.length < 4) {
          throw new Error("Pronto requires at least four words.");
        }
        const header = words.slice(0, 4).map((word) => parseInt(word, 16));
        if (Number.isNaN(header[0]) || header[0] !== 0) {
          throw new Error("Only raw (0000) Pronto strings are supported.");
        }
        const freqWord = header[1];
        if (!freqWord) {
          throw new Error("Invalid frequency word in Pronto string.");
        }
        const totalPairs = header[2] + header[3];
        const payload = words.slice(4).map((word) => parseInt(word, 16));
        const expectedWords = totalPairs > 0 ? totalPairs * 2 : payload.length;
        if (payload.length < expectedWords) {
          throw new Error("Pronto payload is shorter than expected.");
        }
        const baseUnit = freqWord * config.prontoClock;
        const timings = normaliseTimings(
          payload.map((word) => word * baseUnit)
        );
        if (!timings.length) {
          throw new Error("No valid timings decoded from Pronto.");
        }
        const frequencyHz = Math.round(
          1_000_000 / (freqWord * config.prontoClock)
        );
        return { timings, frequencyHz, leadingMark: true };
      },
      format(currentState) {
        const freqHz = currentState.frequencyHz || config.defaultFrequency;
        const freqWord = Math.max(
          1,
          Math.round(1_000_000 / (freqHz * config.prontoClock))
        );
        const unit = freqWord * config.prontoClock;
        const words = currentState.timings.map((duration) =>
          Math.max(1, Math.round(duration / unit))
        );
        const introPairs = Math.ceil(words.length / 2);
        const header = [
          "0000",
          toHexWord(freqWord),
          toHexWord(introPairs),
          "0000",
        ];
        const body = words.map((value) => toHexWord(value));
        return [...header, ...body]
          .reduce((acc, word, index) => {
            acc.push(word);
            if ((index + 1) % 8 === 0) {
              acc.push("\n");
            }
            return acc;
          }, [])
          .join(" ")
          .replace(/\s+\n/g, "\n")
          .trim();
      },
    },
    lirc: {
      parse(value) {
        const parts = value
          .trim()
          .split(/[\s]+/)
          .filter(Boolean)
          .map((token) => parseFloat(token));
        if (!parts.length) {
          throw new Error("LIRC format requires space separated numbers.");
        }
        const timings = normaliseTimings(parts);
        if (!timings.length) {
          throw new Error("No valid durations in LIRC string.");
        }
        return { timings };
      },
      format(currentState) {
        return currentState.timings.join(" ");
      },
    },
    json: {
      parse(value) {
        let parsed;
        try {
          parsed = JSON.parse(value);
        } catch (error) {
          throw new Error("JSON array could not be parsed.");
        }
        if (!Array.isArray(parsed)) {
          throw new Error("JSON input must be an array of durations.");
        }
        const timings = normaliseTimings(parsed);
        if (!timings.length) {
          throw new Error("JSON array is empty or invalid.");
        }
        return { timings };
      },
      format(currentState) {
        return JSON.stringify(currentState.timings);
      },
    },
    arduino: {
      parse(value) {
        const braceMatch = value.match(/\{([^}]*)\}/);
        if (!braceMatch) {
          throw new Error(
            "Arduino format requires a brace enclosed list of numbers."
          );
        }
        const numbers = braceMatch[1]
          .split(/[\s,]+/)
          .map((token) => token.trim())
          .filter(Boolean)
          .map((token) => parseFloat(token));
        const timings = normaliseTimings(numbers);
        if (!timings.length) {
          throw new Error("No valid durations in Arduino snippet.");
        }
        return { timings };
      },
      format(currentState) {
        const count = currentState.timings.length;
        return `const uint16_t rawData[${count}] = { ${currentState.timings.join(
          ", "
        )} };`;
      },
    },
  };

  elements.inputs.forEach((input) => {
    input.addEventListener("input", (event) => {
      if (isUpdating) {
        return;
      }
      const format = event.currentTarget.dataset.format;
      const handler = formatHandlers[format];
      if (!handler) {
        return;
      }
      const rawValue = event.currentTarget.value;
      if (!rawValue.trim()) {
        clearState();
        updateUI();
        return;
      }
      try {
        const result = handler.parse(rawValue);
        state.timings = result.timings;
        state.sourceFormat = format;
        state.leadingMark =
          typeof result.leadingMark === "boolean"
            ? result.leadingMark
            : state.leadingMark;
        if (typeof result.frequencyHz === "number" && result.frequencyHz > 0) {
          setFrequency(result.frequencyHz, true);
        }
        clearMessage(format);
        updateUI(event.currentTarget);
        scheduleMetadataFetch();
      } catch (error) {
        setMessage(format, error.message, true);
      }
    });
  });

  elements.frequency.addEventListener("change", () => {
    const value = Number(elements.frequency.value);
    if (!Number.isFinite(value) || value <= 0) {
      setMessage("frequency", "Frequency must be a positive number.", true);
      elements.frequency.value = state.frequencyHz;
      return;
    }
    clearMessage("frequency");
    setFrequency(value, true);
    if (state.timings.length) {
      updateUI();
    }
  });

  elements.settings.endpoint.addEventListener("change", () => {
    const value = elements.settings.endpoint.value.trim();
    if (!value) {
      setMessage("endpoint", "Endpoint is required.", true);
      return;
    }
    try {
      new URL(value);
    } catch (error) {
      setMessage("endpoint", "Endpoint must be a valid URL.", true);
      return;
    }
    clearMessage("endpoint");
    config.irsockEndpoint = value;
    if (state.timings.length) {
      scheduleMetadataFetch(true);
    }
  });

  elements.settings.defaultFrequency.addEventListener("change", () => {
    const value = Number(elements.settings.defaultFrequency.value);
    if (!Number.isFinite(value) || value <= 0) {
      setMessage(
        "defaultFrequency",
        "Default frequency must be a positive number.",
        true
      );
      elements.settings.defaultFrequency.value = config.defaultFrequency;
      return;
    }
    clearMessage("defaultFrequency");
    config.defaultFrequency = Math.round(value);
    resetFrequencyToDefault();
    if (state.timings.length) {
      updateUI();
    }
  });

  elements.settings.prontoClock.addEventListener("change", () => {
    const value = Number(elements.settings.prontoClock.value);
    if (!Number.isFinite(value) || value <= 0) {
      setMessage("prontoClock", "Pronto clock must be greater than zero.", true);
      elements.settings.prontoClock.value = config.prontoClock;
      return;
    }
    clearMessage("prontoClock");
    config.prontoClock = value;
    if (state.timings.length) {
      updateUI();
    }
  });

  elements.copyButton.addEventListener("click", async () => {
    if (!state.timings.length) {
      return;
    }
    const payload = buildSummaryJson();
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      elements.copyButton.textContent = "Copied!";
      setTimeout(() => {
        elements.copyButton.textContent = "Copy All Formats";
      }, 1200);
    } catch (error) {
      setMessage("frequency", "Clipboard permission denied.", true);
    }
  });

  elements.clearButton.addEventListener("click", () => {
    clearState();
    elements.inputs.forEach((input) => {
      input.value = "";
    });
    resetFrequencyToDefault();
    updateUI();
  });

  function clearState() {
    state.timings = [];
    state.sourceFormat = null;
    state.leadingMark = true;
    state.irsock = null;
    state.lastError = null;
    if (metadataTimer) {
      clearTimeout(metadataTimer);
    }
    resetFrequencyToDefault();
  }

  function scheduleMetadataFetch(immediate = false) {
    if (metadataTimer) {
      clearTimeout(metadataTimer);
    }
    if (!state.timings.length) {
      renderMetadata();
      return;
    }
    if (!config.irsockEndpoint) {
      state.lastError = "IRSock endpoint is not configured.";
      renderMetadata();
      return;
    }
    if (immediate) {
      fetchMetadata();
      return;
    }
    metadataTimer = setTimeout(fetchMetadata, 500);
  }

  async function fetchMetadata() {
    const body = JSON.stringify({
      raw: state.timings,
      ir_delay: 50,
    });
    try {
      const response = await fetch(config.irsockEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body,
      });
      if (!response.ok) {
        throw new Error(`IRSock responded with ${response.status}`);
      }
      const json = await response.json();
      state.irsock = json;
      state.lastError = null;
      if (json && json.frequency_hz) {
        setFrequency(json.frequency_hz, true);
      }
      renderMetadata();
      updateJsonOutput();
    } catch (error) {
      state.lastError = error.message;
      renderMetadata();
    }
  }

  function updateUI(skipElement) {
    isUpdating = true;
    if (!state.timings.length) {
      elements.copyButton.disabled = true;
      elements.jsonOutput.textContent = "";
      renderMetadata();
      isUpdating = false;
      return;
    }
    elements.copyButton.disabled = false;
    elements.inputs.forEach((input) => {
      if (input === skipElement) {
        return;
      }
      const handler = formatHandlers[input.dataset.format];
      if (!handler || typeof handler.format !== "function") {
        return;
      }
      try {
        input.value = handler.format(state);
        clearMessage(input.dataset.format);
      } catch (error) {
        setMessage(input.dataset.format, error.message, true);
      }
    });
    updateJsonOutput();
    renderMetadata();
    isUpdating = false;
  }

  function updateJsonOutput() {
    if (!state.timings.length) {
      elements.jsonOutput.textContent = "";
      return;
    }
    const payload = buildSummaryJson();
    elements.jsonOutput.textContent = JSON.stringify(payload, null, 2);
  }

  function buildSummaryJson() {
    const summary = {
      _metadata: {
        generated_at: new Date().toISOString(),
        source_format: state.sourceFormat,
        frequency_hz: state.frequencyHz,
        sample_count: state.timings.length,
        settings: {
          irsock_endpoint: config.irsockEndpoint,
          default_frequency_hz: config.defaultFrequency,
          pronto_clock_us: config.prontoClock,
        },
      },
      raw: formatHandlers.raw.format(state),
      csv: formatHandlers.csv.format(state),
      pronto: formatHandlers.pronto.format(state),
      lirc: formatHandlers.lirc.format(state),
      json: formatHandlers.json.format(state),
      arduino: formatHandlers.arduino.format(state),
      raw_array: state.timings,
    };
    if (state.irsock) {
      summary._metadata.irsock = state.irsock;
    }
    return summary;
  }

  function renderMetadata() {
    elements.metadata.replaceChildren();
    if (!state.timings.length) {
      appendText(
        elements.metadata,
        "Provide any supported format to fetch metadata."
      );
      return;
    }
    if (state.lastError) {
      appendText(elements.metadata, `IRSock error: ${state.lastError}`);
      return;
    }
    if (!state.irsock) {
      appendText(elements.metadata, "Fetching IRSock metadata…");
      return;
    }
    const dl = document.createElement("dl");
    Object.entries(state.irsock).forEach(([key, value]) => {
      const dt = document.createElement("dt");
      dt.textContent = key;
      const dd = document.createElement("dd");
      dd.textContent =
        typeof value === "object" ? JSON.stringify(value) : String(value);
      dl.append(dt, dd);
    });
    elements.metadata.appendChild(dl);
  }

  function resetFrequencyToDefault() {
    setFrequency(config.defaultFrequency, true);
  }

  function setFrequency(value, syncInput = false) {
    if (!Number.isFinite(value) || value <= 0) {
      return;
    }
    state.frequencyHz = Math.round(value);
    if (syncInput && Number(elements.frequency.value) !== state.frequencyHz) {
      elements.frequency.value = state.frequencyHz;
    }
  }

  function normaliseTimings(values) {
    return values
      .map((value) => Math.round(Math.abs(Number(value))))
      .filter((value) => Number.isFinite(value) && value > 0);
  }

  function buildSignedSequence(timings, leadingMark) {
    const parts = [];
    let mark = leadingMark;
    timings.forEach((duration) => {
      const prefix = mark ? "+" : "-";
      parts.push(`${prefix}${duration}`);
      mark = !mark;
    });
    return parts.join(" ");
  }

  function toHexWord(value) {
    return value.toString(16).toUpperCase().padStart(4, "0");
  }

  function appendText(target, text) {
    const paragraph = document.createElement("p");
    paragraph.textContent = text;
    target.appendChild(paragraph);
  }

  function setMessage(format, message, isError) {
    const node = elements.messages.get(format);
    if (!node) {
      return;
    }
    node.textContent = message;
    node.classList.toggle("error", Boolean(isError));
  }

  function clearMessage(format) {
    const node = elements.messages.get(format);
    if (!node) {
      return;
    }
    node.textContent = "";
    node.classList.remove("error");
  }

  function getStringParam(search, key, fallback) {
    const value = search.get(key);
    if (typeof value !== "string") {
      return fallback;
    }
    const trimmed = value.trim();
    return trimmed.length ? trimmed : fallback;
  }

  function getNumberParam(search, key, fallback, validator = (value) => true) {
    const value = search.get(key);
    if (value === null) {
      return fallback;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || !validator(parsed)) {
      return fallback;
    }
    return parsed;
  }

  function applyInitialFormatParam() {
    const priorityFormats = ["raw", "csv", "pronto", "lirc", "json", "arduino"];
    for (const format of priorityFormats) {
      const value = params.get(format);
      if (typeof value === "string" && value.trim().length) {
        const target = elements.inputMap.get(format);
        if (!target) {
          continue;
        }
        target.value = value;
        target.dispatchEvent(new Event("input"));
        return true;
      }
    }
    return false;
  }

  elements.settings.endpoint.value = config.irsockEndpoint;
  elements.settings.defaultFrequency.value = config.defaultFrequency;
  elements.settings.prontoClock.value = config.prontoClock;
  resetFrequencyToDefault();

  const frequencyParam = getNumberParam(
    params,
    "frequency",
    state.frequencyHz,
    (value) => value > 0
  );
  setFrequency(frequencyParam, true);

  const formatApplied = applyInitialFormatParam();
  if (!formatApplied) {
    updateUI();
  }
})();
