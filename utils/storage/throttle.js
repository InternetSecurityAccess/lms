// utils/storage/throttle.js
'use strict';
const { Transform } = require('node:stream');

/**
 * Transform-stream, ограничивающий пропускную способность.
 * Пропускает chunk, затем ждёт, пока средняя скорость не сравняется
 * с bytesPerSecond, и только потом отдаёт chunk дальше.
 *
 * Задержка реализована через setTimeout + callback в _transform.
 * Пока callback не вызван, pipe не читает следующий chunk из источника
 * (backpressure) — память не растёт.
 */
class ThrottleTransform extends Transform {
  constructor(bytesPerSecond) {
    super();
    this.bytesPerSecond = bytesPerSecond;
    this.bytesProcessed = 0;
    this.startTime = Date.now();
  }
  _transform(chunk, encoding, callback) {
    this.bytesProcessed += chunk.length;
    const elapsedSec = (Date.now() - this.startTime) / 1000;
    const expectedSec = this.bytesProcessed / this.bytesPerSecond;
    const delayMs = Math.max(0, expectedSec - elapsedSec) * 1000;
    if (delayMs > 0) {
      setTimeout(() => callback(null, chunk), delayMs);
    } else {
      callback(null, chunk);
    }
  }
}

module.exports = { ThrottleTransform };