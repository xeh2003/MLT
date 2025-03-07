const checkpointURL = "http://localhost:53527/model.json";
const metadataURL = "http://localhost:53527/metadata.json";

async function delay(ms) {
    return new Promise((res) => setTimeout(res, ms));
}

function flattenQueue(queue) {
    const frameSize = queue[0].length;
    const freqData = new Float32Array(queue.length * frameSize);
    queue.forEach((data, i) => freqData.set(data, i * frameSize));
    return freqData;
}

function normalize(x) {
    const EPSILON = tf.backend().epsilon();
    return tf.tidy(() => {
        const { mean, variance } = tf.moments(x);
        return tf.div(tf.sub(x, mean), tf.add(tf.sqrt(variance), EPSILON));
    });
}

function getInputTensorFromFrequencyData(freqData, shape) {
    const vals = new Float32Array(tf.util.sizeFromShape(shape));
    vals.set(freqData, vals.length - freqData.length);
    return tf.tensor(vals, shape);
}

class Tracker {
    constructor(period, suppressionPeriod) {
        this.period = period;
        this.suppressionTime = suppressionPeriod == null ? 0 : suppressionPeriod;
        this.counter = 0;
        tf.util.assert(this.period > 0, () => `Expected period to be positive, but got ${this.period}`);
    }

    tick() {
        this.counter++;
        const shouldFire =
            this.counter % this.period === 0 &&
            (this.suppressionOnset == null || this.counter - this.suppressionOnset > this.suppressionTime);
        return shouldFire;
    }

    suppress() {
        this.suppressionOnset = this.counter;
    }
}

class BrowserFftFeatureExtractor {
    constructor(config) {
        if (config == null) {
            throw new Error(`Required configuration object is missing for BrowserFftFeatureExtractor constructor`);
        }

        if (config.spectrogramCallback == null) {
            throw new Error(`spectrogramCallback cannot be null or undefined`);
        }

        if (config.numFramesPerSpectrogram <= 0) {
            throw new Error(`Invalid value in numFramesPerSpectrogram: ${config.numFramesPerSpectrogram}`);
        }

        if (config.suppressionTimeMillis < 0) {
            throw new Error(`Expected suppressionTimeMillis to be >= 0, but got ${config.suppressionTimeMillis}`);
        }
        this.suppressionTimeMillis = config.suppressionTimeMillis;

        this.spectrogramCallback = config.spectrogramCallback;
        this.numFrames = config.numFramesPerSpectrogram;
        this.sampleRateHz = config.sampleRateHz || 44100;
        this.fftSize = config.fftSize || 1024;
        this.frameDurationMillis = (this.fftSize / this.sampleRateHz) * 1e3;
        this.columnTruncateLength = config.columnTruncateLength || this.fftSize;
        this.overlapFactor = config.overlapFactor;
        this.includeRawAudio = config.includeRawAudio;

        tf.util.assert(
            this.overlapFactor >= 0 && this.overlapFactor < 1,
            () => `Expected overlapFactor to be >= 0 and < 1, but got ${this.overlapFactor}`
        );

        if (this.columnTruncateLength > this.fftSize) {
            throw new Error(`columnTruncateLength ${this.columnTruncateLength} exceeds fftSize (${this.fftSize}).`);
        }
    }

    async start(audioNode) {
        if (this.frameIntervalTask != null) {
            throw new Error("Cannot start already-started BrowserFftFeatureExtractor");
        }

        this.analyser = audioNode;
        this.analyser.fftSize = this.fftSize * 2;
        this.analyser.smoothingTimeConstant = 0.0;

        this.freqDataQueue = [];
        this.freqData = new Float32Array(this.fftSize);
        if (this.includeRawAudio) {
            this.timeDataQueue = [];
            this.timeData = new Float32Array(this.fftSize);
        }
        const period = Math.max(1, Math.round(this.numFrames * (1 - this.overlapFactor)));
        this.tracker = new Tracker(period, Math.round(this.suppressionTimeMillis / this.frameDurationMillis));
        this.frameIntervalTask = setInterval(this.onAudioFrame.bind(this), (this.fftSize / this.sampleRateHz) * 1e3);
    }

    async onAudioFrame() {
        this.analyser.getFloatFrequencyData(this.freqData);
        if (this.freqData[0] === -Infinity) {
            return;
        }

        this.freqDataQueue.push(this.freqData.slice(0, this.columnTruncateLength));
        if (this.includeRawAudio) {
            this.analyser.getFloatTimeDomainData(this.timeData);
            this.timeDataQueue.push(this.timeData.slice());
        }
        if (this.freqDataQueue.length > this.numFrames) {
            this.freqDataQueue.shift();
        }
        const shouldFire = this.tracker.tick();
        if (shouldFire) {
            const freqData = flattenQueue(this.freqDataQueue);
            const freqDataTensor = getInputTensorFromFrequencyData(freqData, [
                1,
                this.numFrames,
                this.columnTruncateLength,
                1
            ]);
            let timeDataTensor;
            if (this.includeRawAudio) {
                const timeData = flattenQueue(this.timeDataQueue);
                timeDataTensor = getInputTensorFromFrequencyData(timeData, [1, this.numFrames * this.fftSize]);
            }
            const shouldRest = await this.spectrogramCallback(freqDataTensor, timeDataTensor);
            if (shouldRest) {
                this.tracker.suppress();
            }
            tf.dispose([freqDataTensor, timeDataTensor]);
        }
    }

    async stop() {
        if (this.frameIntervalTask == null) {
            throw new Error("Cannot stop because there is no ongoing streaming activity.");
        }
        clearInterval(this.frameIntervalTask);
        this.frameIntervalTask = null;
        this.analyser.disconnect();
        this.audioContext.close();
        if (this.stream != null && this.stream.getTracks().length > 0) {
            this.stream.getTracks()[0].stop();
        }
    }
}

class AudioPlayerControls {
    constructor(context, volNode, listenerNode, spectrogram) {
        this.context = context;
        this.volNode = volNode;
        this.listenerNode = listenerNode;
        this.spectrogram = spectrogram;
        this.sourceNode = null;
        this.buffer = null;
    }

    play(arrayBuffer) {
        this.context.decodeAudioData(arrayBuffer, (audioData) => {
            this.buffer = audioData;
            this.sourceNode = this.context.createBufferSource();
            this.sourceNode.connect(this.volNode);
            this.sourceNode.connect(this.listenerNode);
            this.sourceNode.buffer = this.buffer;
            this.sourceNode.start(0);
            this.sourceNode.addEventListener("ended", () => {
                this.spectrogram.halt();
            });
            this.spectrogram.begin();
        });
    }

    stop() {
        if (this.sourceNode) {
            this.sourceNode.disconnect();
            this.sourceNode.stop(0);
            this.sourceNode = null;
        }
    }

    changeVolume(element) {
        let volume = element.value;
        let fraction = parseInt(element.value) / parseInt(element.max);
        this.volNode.gain.value = fraction * fraction;
    }
}

class AudioSpectrogram {
    constructor(analyserNode, canvasID) {
        this.analyserNode = analyserNode;
        this.frqBuf = new Uint8Array(analyserNode.frequencyBinCount);
        const binCnt = analyserNode.fftSize / 2;
        const wfNumPts = (300 * analyserNode.frequencyBinCount) / binCnt;
        const wfBufAry = { buffer: this.frqBuf };
        this.wf = new Waterfall(wfBufAry, wfNumPts, wfNumPts, "right", { lineRate: 30 });
        const canvas = document.getElementById(canvasID);
        this.ctx = canvas.getContext("2d");
        this.playing = false;
    }

    begin() {
        this.wf.start();
        this.playing = true;
        this.drawOnScreen();
    }

    halt() {
        this.wf.stop();
        this.playing = false;
        delay(5000).then(() => {
            showMP3Result();
        });
    }

    drawOnScreen() {
        this.analyserNode.getByteFrequencyData(this.frqBuf, 0);
        this.ctx.drawImage(this.wf.offScreenCvs, 0, 0);
        if (this.playing)
            requestAnimationFrame(() => {
                this.drawOnScreen();
            });
    }
}

let fileNameLabel;
let labelContainer;
let resultMP3Label;
let startButton;
let stopButton;
let predictionCounter;
let predictionSumArray;
let isProcess;

window.startMP3 = function () {
    if (isProcess) {
        return;
    }
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".mp3,.wav";
    input.onchange = function () {
        const fileReader = new FileReader();
        fileReader.onload = function () {
            window.playerControls.play(this.result);
        };
        isProcess = true;
        const files = Array.from(input.files);
        fileReader.readAsArrayBuffer(files[0]);
        fileNameLabel.innerHTML = `Файл фонокардиограммы: ${files[0].name}`;
        resultMP3Label.innerHTML = "Результат после остановки ожидать 5 секунд";
        resultMP3Label.style.backgroundColor = "white";
    };
    input.click();
};

window.stopMP3 = function () {
    if (!isProcess) {
        return;
    }
    window.playerControls.stop();
};

function showMP3Result() {
    const diagnoses = [
        "Аортальная недостаточность",
        "Аортальный стеноз",
        "Митральная недостаточность",
        "Митральный стеноз",
        "Отклонений не выявлено"
    ];
    let diagnosesArray = new Float32Array(5);
    for (let i = 0; i != labelContainer.childElementCount; i++) {
        let t = (predictionSumArray[i] / predictionCounter).toFixed(3);
        diagnosesArray[i] = t;
        labelContainer.childNodes[i].innerHTML = diagnoses[i] + ": " + t;
        labelContainer.childNodes[i].style.backgroundColor = "white";
    }
    let i = diagnosesArray.indexOf(Math.max(...diagnosesArray));
    if (i === 4) {
        resultMP3Label.innerHTML = "Вероятной сердечно-сосудистой патологии не выявлено";
    } else {
        resultMP3Label.innerHTML = `Вероятна сердечно-сосудистая патология «${diagnoses[i]}», рекомендуются дополнительные исследования`;
    }
    resultMP3Label.style.backgroundColor = "pink";
    predictionCounter = 0;
    for (let i = 0; i != labelContainer.childElementCount; i++) {
        predictionSumArray[i] = 0;
    }
    isProcess = false;
}

async function init() {
    isProcess = false;
    const context = new AudioContext({ sampleRate: 44100 });
    const splitterNode = context.createChannelSplitter(2);
    const leftAnalyserNode = context.createAnalyser({ fftSize: 1024 });
    const rightAnalyserNode = context.createAnalyser({ fftSize: 1024 });
    const gainNode = context.createGain();
    const audioNode = leftAnalyserNode;
    const spectrogram = new AudioSpectrogram(audioNode, "audio-canvas");
    splitterNode.connect(leftAnalyserNode, 0);
    splitterNode.connect(rightAnalyserNode, 1);
    gainNode.connect(context.destination);
    window.playerControls = new AudioPlayerControls(context, gainNode, splitterNode, spectrogram);
    window.playerControls.changeVolume(document.getElementById("volume-slider"));

    const recognizer = speechCommands.create("BROWSER_FFT", undefined, checkpointURL, metadataURL);
    await recognizer.ensureModelLoaded();
    const classLabels = recognizer.wordLabels();
    labelContainer = document.getElementById("label-container");
    for (let i = 0; i < classLabels.length; i++) {
        labelContainer.appendChild(document.createElement("div"));
        labelContainer.childNodes[i].innerHTML = classLabels[i] + ": 0.00";
        labelContainer.childNodes[i].style.backgroundColor = "white";
    }
    resultMP3Label = document.getElementById("result-label");
    resultMP3Label.innerHTML = ">";
    resultMP3Label.style.backgroundColor = "white";
    predictionCounter = 0;
    predictionSumArray = new Float32Array(5);

    const nonBatchInputShape = recognizer.model.inputs[0].shape.slice(1);
    const config = {
        sampleRateHz: 44100,
        numFramesPerSpectrogram: nonBatchInputShape[0],
        columnTruncateLength: nonBatchInputShape[1],
        suppressionTimeMillis: 0,
        spectrogramCallback: async function (freqDataTensor, timeDataTensor) {
            let result = await recognizer.recognize(normalize(freqDataTensor));
            let scores = result.scores;
            predictionCounter += 1;
            for (let i = 0; i < classLabels.length; i++) {
                let t = result.scores[i].toFixed(2);
                predictionSumArray[i] += result.scores[i];
                const classPrediction = classLabels[i] + ": " + t;
                labelContainer.childNodes[i].innerHTML = classPrediction;
                if (t > 0.5) {
                    labelContainer.childNodes[i].style.backgroundColor = "pink";
                } else {
                    labelContainer.childNodes[i].style.backgroundColor = "white";
                }
            }
            return false;
        },
        overlapFactor: 0.5
    };
    let proc = new BrowserFftFeatureExtractor(config);
    proc.start(audioNode);
}

window.addEventListener("load", function () {
    init().then(function () {
        startButton = document.getElementById("start-button");
        startButton.onclick = window.startMP3;
        stopButton = document.getElementById("stop-button");
        stopButton.onclick = window.stopMP3;
        fileNameLabel = document.getElementById("file-name-container");
        fileNameLabel.innerHTML = ">";
        fileNameLabel.style.backgroundColor = "white";
    });
});
