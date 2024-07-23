
declare module 'ethstorage-sdk-file' {
    // Classes
    export class NodeFile {
      constructor(filePath: string, start: number, end?: number, type?: string);
      slice(start: number, end: number): NodeFile;
      arrayBuffer(): Promise<Buffer>;
      text(): Promise<string>;
      // stream(): ReadStream;
    }

    export default NodeFile;
}
