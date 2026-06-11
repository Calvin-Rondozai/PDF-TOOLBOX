export class TtsReader {
  constructor() {
    this.speaking = false;
    this.segments = [];
    this.segmentIndex = 0;
    this.onSentence = null;
    this.onPageChange = null;
    this.onDone = null;
    this.voices = [];
    this.rate = 1.0;
    this.voice = null;
    this._loadVoices();
    if (window.speechSynthesis) {
      window.speechSynthesis.onvoiceschanged = () => this._loadVoices();
    }
  }

  _loadVoices() {
    if (!window.speechSynthesis) return;
    this.voices = window.speechSynthesis.getVoices();
  }

  getVoiceList() {
    return this.voices.map((v) => ({ name: v.name, lang: v.lang, id: v.voiceURI }));
  }

  setVoice(voiceURI) {
    this.voice = this.voices.find((v) => v.voiceURI === voiceURI) || null;
  }

  setRate(rate) {
    this.rate = rate;
  }

  _splitSentences(text) {
    return text
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 8);
  }

  async startFromPage(extractFn, startPage, pageCount) {
    this.stop();
    this.segments = [];
    for (let i = startPage; i < pageCount; i++) {
      const text = await extractFn(i);
      if (text && text.trim()) {
        const sentences = this._splitSentences(text);
        for (const sent of sentences) {
          this.segments.push({ page: i, text: sent });
        }
      }
    }
    if (!this.segments.length) return false;
    this.segmentIndex = 0;
    this.speaking = true;
    this._speakNext();
    return true;
  }

  _speakNext() {
    if (!this.speaking || this.segmentIndex >= this.segments.length) {
      this.speaking = false;
      if (this.onDone) this.onDone();
      return;
    }

    const seg = this.segments[this.segmentIndex];
    if (this.onPageChange) this.onPageChange(seg.page);

    const utter = new SpeechSynthesisUtterance(seg.text);
    utter.rate = this.rate;
    if (this.voice) utter.voice = this.voice;

    utter.onend = () => {
      if (this.onSentence) this.onSentence(seg);
      this.segmentIndex++;
      this._speakNext();
    };

    utter.onerror = () => {
      this.segmentIndex++;
      this._speakNext();
    };

    window.speechSynthesis.speak(utter);
  }

  stop() {
    this.speaking = false;
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    this.segments = [];
    this.segmentIndex = 0;
  }

  get isSpeaking() {
    return this.speaking;
  }
}
