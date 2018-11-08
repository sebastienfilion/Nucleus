"use strict";

/**
 * @fileOverview Define the Nucleus Error class that extends the Error type.
 *
 * @author Sebastien Filion
 */
const nucleusValidator = require('./validator.nucleus');

const $$stackOriginMetaRegularExpression = new RegExp('^([A-Za-z]+):.*\\s*at\\s(.*)\\s\\((.*):([0-9]+):([0-9]+)\\)', 'm');

/**
 * @module NucleusError
 * @typedef NucleusError
 * @property {String} name
 * @property {Number} errorCode
 * @property {String} nucleusErrorType
 * @property {String} stackName
 * @property {String} stackFileName
 * @property {String} stackLineNumber
 * @property {String} stackColumnNumber
 */

class NucleusError extends Error {

  /**
   * Creates a Nucleus Error.
   *
   * @argument {String} errorMessage
   * @argument {Object} options
   */
  constructor (errorMessage, options = {}) {
    super(errorMessage);

    const { error } = options;

    this.name = 'NucleusError';
    this.errorCode = 600;

    Object.defineProperties(this, {
      '_meta': { writable: true, enumerable: false },
      'meta': {
        enumerable: true,
        get: () => {
          return this._meta;
        },
        set: (options) => {
          let accumulator = {};

          if (options.error) {
            accumulator = options.error.meta;
          }

          Reflect.deleteProperty(options, 'error');
          this._meta = Object.assign(options, accumulator);
          return true;
        }
      }
    });

    if (!!error && error instanceof Error && 'stack' in error) this.stack = error.stack;

    const [ nucleusErrorType, stackName, stackFileName, stackLineNumber, stackColumnNumber ] = (!!error && 'nucleusErrorType' in error) ?
      [ error.nucleusErrorType, error.stackName, error.stackFileName, error.stackLineNumber, error.stackColumnNumber ] :
      (((error || this).stack || '').match($$stackOriginMetaRegularExpression) || []).splice(1);

    Object.assign(this, { nucleusErrorType, stackName, stackFileName, stackLineNumber, stackColumnNumber });

    Reflect.defineProperty(this, 'message', {
      value: this.message,
      writable: false,
      enumerable: true
    });

    if (!nucleusValidator.isEmpty(options)) {
      this.meta = options;
    }
  }

  [Symbol.toPrimitive] (primitiveType) {
    // If forced to a String, it will return a summary of the action that could be used as a Key.
    // If forced to a Number, it will return the status weight.
    if (primitiveType === 'string') return `${this.name} (${this.stackName}:${this.stackLineNumber}:${this.stackColumnNumber}) - ${this.message}`;
    if (primitiveType === 'number') return this.errorCode;
  }

  get [Symbol.toStringTag] () {

    return 'NucleusError';
  }

}

class UnauthorizedActionNucleusError extends NucleusError {

  /**
   * Creates a Undefined Context Nucleus Error.
   * @memberOf NucleusError
   *
   * @argument {String} errorMessage
   */
  constructor (errorMessage, options) {
    super(errorMessage, options);

    this.name = 'UnauthorizedActionNucleusError';
    this.errorCode = 605;
  }
}

class UndefinedContextNucleusError extends NucleusError {

  /**
   * Creates a Undefined Context Nucleus Error.
   * @memberOf NucleusError
   *
   * @argument {String} errorMessage
   */
  constructor (errorMessage, options) {
    super(errorMessage, options);

    this.name = 'UndefinedContextNucleusError';
    this.errorCode = 604;
  }
}

class UndefinedValueNucleusError extends NucleusError {

  /**
   * Creates a Undefined Value Nucleus Error.
   * @memberOf NucleusError
   *
   * @argument {String} errorMessage
   */
  constructor (errorMessage, options) {
    super(errorMessage, options);

    this.name = 'UndefinedValueNucleusError';
    this.errorCode = 601;
  }

}

class UnexpectedValueNucleusError extends NucleusError {

  /**
   * Creates a Unexpected Value Nucleus Error.
   * @memberOf NucleusError
   *
   * @argument {String} errorMessage
   */
  constructor (errorMessage, options) {
    super(errorMessage, options);

    this.name = 'UnexpectedValueNucleusError';
    this.errorCode = 602;
  }

}

class UnexpectedValueTypeNucleusError extends NucleusError {

  /**
   * Creates a Unexpected Value Type Nucleus Error.
   * @memberOf NucleusError
   *
   * @argument {String} errorMessage
   */
  constructor (errorMessage, options) {
    super(errorMessage, options);

    this.name = 'UnexpectedValueTypeNucleusError';
    this.errorCode = 603;
  }

}

NucleusError.UnauthorizedActionNucleusError = UnauthorizedActionNucleusError;
NucleusError.UndefinedContextNucleusError = UndefinedContextNucleusError;
NucleusError.UndefinedValueNucleusError = UndefinedValueNucleusError;
NucleusError.UnexpectedValueNucleusError = UnexpectedValueNucleusError;
NucleusError.UnexpectedValueTypeNucleusError = UnexpectedValueTypeNucleusError;

module.exports = NucleusError;
