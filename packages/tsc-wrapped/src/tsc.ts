/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {existsSync} from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

import AngularCompilerOptions from './options';
import {VinylFile, isVinylFile} from './vinyl_file';

/**
 * Our interface to the TypeScript standard compiler.
 * If you write an Angular compiler plugin for another build tool,
 * you should implement a similar interface.
 */
export interface CompilerInterface {
  readConfiguration(
      project: string|VinylFile, basePath: string, existingOptions?: ts.CompilerOptions):
      {parsed: ts.ParsedCommandLine, ngOptions: AngularCompilerOptions};
  typeCheck(compilerHost: ts.CompilerHost, program: ts.Program): void;
  emit(program: ts.Program): number;
}

export class UserError extends Error {
  private _nativeError: Error;

  constructor(message: string) {
    super(message);
    // Required for TS 2.1, see
    // https://github.com/Microsoft/TypeScript/wiki/Breaking-Changes#extending-built-ins-like-error-array-and-map-may-no-longer-work
    (Object as any).setPrototypeOf(this, UserError.prototype);

    const nativeError = new Error(message) as any as Error;
    this._nativeError = nativeError;
  }

  get message() { return this._nativeError.message; }
  set message(message) {
    if (this._nativeError) this._nativeError.message = message;
  }
  get name() { return this._nativeError.name; }
  set name(name) {
    if (this._nativeError) this._nativeError.name = name;
  }
  get stack() { return (this._nativeError as any).stack; }
  set stack(value) {
    if (this._nativeError) (this._nativeError as any).stack = value;
  }
  toString() { return this._nativeError.toString(); }
}

const DEBUG = false;

function debug(msg: string, ...o: any[]) {
  // tslint:disable-next-line:no-console
  if (DEBUG) console.log(msg, ...o);
}

export function formatDiagnostics(diags: ts.Diagnostic[]): string {
  return diags
      .map((d) => {
        let res = ts.DiagnosticCategory[d.category];
        if (d.file) {
          res += ' at ' + d.file.fileName + ':';
          const {line, character} = d.file.getLineAndCharacterOfPosition(d.start);
          res += (line + 1) + ':' + (character + 1) + ':';
        }
        res += ' ' + ts.flattenDiagnosticMessageText(d.messageText, '\n');
        return res;
      })
      .join('\n');
}

export function check(diags: ts.Diagnostic[] | undefined) {
  if (diags && diags.length && diags[0]) {
    throw new UserError(formatDiagnostics(diags));
  }
}

export function validateAngularCompilerOptions(options: AngularCompilerOptions): ts.Diagnostic[]|
    undefined {
  if (options.annotationsAs) {
    switch (options.annotationsAs) {
      case 'decorators':
      case 'static fields':
        break;
      default:
        return [{
          file: null as any as ts.SourceFile,
          start: null as any as number,
          length: null as any as number,
          messageText:
              'Angular compiler options "annotationsAs" only supports "static fields" and "decorators"',
          category: ts.DiagnosticCategory.Error,
          code: 0
        }];
    }
  }
}

export class Tsc implements CompilerInterface {
  private parseConfigHost: ts.ParseConfigHost;

  constructor(private readFile = ts.sys.readFile, private readDirectory = ts.sys.readDirectory) {
    this.parseConfigHost = {
      useCaseSensitiveFileNames: true,
      fileExists: existsSync,
      readDirectory: this.readDirectory,
      readFile: ts.sys.readFile
    };
  }

  readConfiguration(
      project: string|VinylFile, basePath: string, existingOptions?: ts.CompilerOptions) {
    // Allow a directory containing tsconfig.json as the project value
    // Note, TS@next returns an empty array, while earlier versions throw
    try {
      if (!isVinylFile(project) && this.readDirectory(project).length > 0) {
        project = path.join(project, 'tsconfig.json');
      }
    } catch (e) {
      // Was not a directory, continue on assuming it's a file
    }

    let {config, error} = (() => {
      // project is vinyl like file object
      if (isVinylFile(project)) {
        return {config: JSON.parse(project.contents.toString()), error: null};
      }
      // project is path to project file
      else {
        return ts.readConfigFile(project, this.readFile);
      }
    })();
    check([error !]);

    const parsed =
        ts.parseJsonConfigFileContent(config, this.parseConfigHost, basePath, existingOptions);

    check(parsed.errors);

    // Default codegen goes to the current directory
    // Parsed options are already converted to absolute paths
    const ngOptions = config.angularCompilerOptions || {};
    ngOptions.genDir = path.join(basePath, ngOptions.genDir || '.');
    for (const key of Object.keys(parsed.options)) {
      ngOptions[key] = parsed.options[key];
    }
    check(validateAngularCompilerOptions(ngOptions));

    return {parsed, ngOptions};
  }

  typeCheck(compilerHost: ts.CompilerHost, program: ts.Program): void {
    debug('Checking global diagnostics...');
    check(program.getGlobalDiagnostics());

    const diagnostics: ts.Diagnostic[] = [];
    debug('Type checking...');

    for (const sf of program.getSourceFiles()) {
      diagnostics.push(...ts.getPreEmitDiagnostics(program, sf));
    }
    check(diagnostics);
  }

  emit(program: ts.Program): number {
    debug('Emitting outputs...');
    const emitResult = program.emit();
    const diagnostics: ts.Diagnostic[] = [];
    diagnostics.push(...emitResult.diagnostics);
    return emitResult.emitSkipped ? 1 : 0;
  }
}
export const tsc: CompilerInterface = new Tsc();
