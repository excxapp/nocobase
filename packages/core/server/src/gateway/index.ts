import { Command } from 'commander';
import compression from 'compression';
import { EventEmitter } from 'events';
import http, { IncomingMessage, ServerResponse } from 'http';
import { promisify } from 'node:util';
import { resolve } from 'path';
import qs from 'qs';
import handler from 'serve-handler';
import { parse } from 'url';
import xpipe from 'xpipe';
import { AppSupervisor } from '../app-supervisor';
import { ApplicationOptions } from '../application';
import { applyErrorWithArgs, getErrorWithCode } from './errors';
import { IPCSocketClient } from './ipc-socket-client';
import { IPCSocketServer } from './ipc-socket-server';
import { WSServer } from './ws-server';

const compress = promisify(compression());

export interface IncomingRequest {
  url: string;
  headers: any;
}

export type AppSelector = (req: IncomingRequest) => string | Promise<string>;

interface StartHttpServerOptions {
  port: number;
  host: string;
  callback?: (server: http.Server) => void;
}

interface RunOptions {
  mainAppOptions: ApplicationOptions;
}

export class Gateway extends EventEmitter {
  private static instance: Gateway;
  /**
   * use main app as default app to handle request
   */
  appSelector: AppSelector;
  public server: http.Server | null = null;
  public ipcSocketServer: IPCSocketServer | null = null;
  private port: number = process.env.APP_PORT ? parseInt(process.env.APP_PORT) : null;
  private host = '0.0.0.0';
  private wsServer: WSServer;
  private socketPath = xpipe.eq(resolve(process.cwd(), 'storage', 'gateway.sock'));

  private constructor() {
    super();
    this.reset();
  }

  public static getInstance(options: any = {}): Gateway {
    if (!Gateway.instance) {
      Gateway.instance = new Gateway();
    }

    return Gateway.instance;
  }

  destroy() {
    this.reset();
    Gateway.instance = null;
  }

  public reset() {
    this.setAppSelector(async (req) => {
      const appName = qs.parse(parse(req.url).query)?.__appName;
      if (appName) {
        return appName;
      }

      if (req.headers['x-app']) {
        return req.headers['x-app'];
      }

      return null;
    });

    if (this.server) {
      this.server.close();
      this.server = null;
    }

    if (this.ipcSocketServer) {
      this.ipcSocketServer.close();
      this.ipcSocketServer = null;
    }
  }

  setAppSelector(selector: AppSelector) {
    this.appSelector = selector;
    this.emit('appSelectorChanged');
  }

  responseError(
    res: ServerResponse,
    error: {
      status: number;
      maintaining: boolean;
      message: string;
      code: string;
    },
  ) {
    res.setHeader('Content-Type', 'application/json');
    res.statusCode = error.status;
    res.end(JSON.stringify({ error }));
  }

  responseErrorWithCode(code, res, options) {
    this.responseError(res, applyErrorWithArgs(getErrorWithCode(code), options));
  }

  async requestHandler(req: IncomingMessage, res: ServerResponse) {
    const { pathname } = parse(req.url);

    if (pathname.startsWith('/storage/uploads/')) {
      await compress(req, res);
      return handler(req, res, {
        public: resolve(process.cwd()),
      });
    }

    if (pathname.startsWith('/api/plugins/client/')) {
      await compress(req, res);
      return handler(req, res, {
        public: resolve(process.cwd(), 'node_modules'),
        rewrites: [
          {
            source: '/api/plugins/client/:plugin/index.js',
            destination: '/:plugin/dist/client/index.js',
          },
          {
            source: '/api/plugins/client/@:org/:plugin/index.js',
            destination: '/@:org/:plugin/dist/client/index.js',
          },
        ],
      });
    }

    if (!pathname.startsWith('/api')) {
      await compress(req, res);
      return handler(req, res, {
        public: `${process.env.APP_PACKAGE_ROOT}/dist/client`,
        rewrites: [{ source: '/**', destination: '/index.html' }],
      });
    }

    const handleApp = await this.getRequestHandleAppName(req as IncomingRequest);

    const hasApp = AppSupervisor.getInstance().hasApp(handleApp);

    if (!hasApp) {
      AppSupervisor.getInstance().bootStrapApp(handleApp);
    }

    const appStatus = AppSupervisor.getInstance().getAppStatus(handleApp, 'initializing');

    if (appStatus === 'not_found') {
      this.responseErrorWithCode('APP_NOT_FOUND', res, { appName: handleApp });
      return;
    }

    if (appStatus === 'initializing') {
      this.responseErrorWithCode('APP_INITIALIZING', res, { appName: handleApp });
      return;
    }

    const app = await AppSupervisor.getInstance().getApp(handleApp);

    if (appStatus !== 'running') {
      this.responseErrorWithCode(`${appStatus}`, res, { app });
      return;
    }

    if (req.url.endsWith('/__health_check')) {
      res.statusCode = 200;
      res.end('ok');
      return;
    }

    app.callback()(req, res);
  }

  async getRequestHandleAppName(req: IncomingRequest) {
    return (await this.appSelector(req)) || 'main';
  }

  getCallback() {
    return this.requestHandler.bind(this);
  }

  async run(options: RunOptions) {
    const isStart = this.isStart();
    if (isStart) {
      const startOptions = this.getStartOptions();
      const port = startOptions.port || process.env.APP_PORT || 13000;
      const host = startOptions.host || process.env.APP_HOST || '0.0.0.0';

      this.start({
        port,
        host,
      });
    } else if (!this.isHelp()) {
      const ipcClient = await this.tryConnectToIPCServer();

      if (ipcClient) {
        ipcClient.write({ type: 'passCliArgv', payload: { argv: process.argv } });
        ipcClient.close();
        return;
      }
    }

    const mainApp = AppSupervisor.getInstance().bootMainApp(options.mainAppOptions);
    mainApp.runAsCLI();
  }

  isStart() {
    const argv = process.argv;
    return argv[2] === 'start';
  }

  isHelp() {
    const argv = process.argv;
    return argv[2] === 'help';
  }

  getStartOptions() {
    const argv = process.argv;
    const program = new Command();

    program
      .allowUnknownOption()
      .option('-s, --silent')
      .option('-p, --port [post]')
      .option('-h, --host [host]')
      .option('--db-sync')
      .parse(process.argv);
    const options = program.opts();

    return options;
  }

  start(options: StartHttpServerOptions) {
    this.startHttpServer(options);
    this.startIPCSocketServer();
  }

  startIPCSocketServer() {
    this.ipcSocketServer = IPCSocketServer.buildServer(this.socketPath);
  }

  startHttpServer(options: StartHttpServerOptions) {
    if (options?.port !== null) {
      this.port = options.port;
    }

    if (options?.host) {
      this.host = options.host;
    }

    if (this.port === null) {
      console.log('gateway port is not set, http server will not start');
      return;
    }

    this.server = http.createServer(this.getCallback());

    this.wsServer = new WSServer();

    this.server.on('upgrade', (request, socket, head) => {
      const { pathname } = parse(request.url);

      if (pathname === '/ws') {
        this.wsServer.wss.handleUpgrade(request, socket, head, (ws) => {
          this.wsServer.wss.emit('connection', ws, request);
        });
      } else {
        socket.destroy();
      }
    });

    this.server.listen(this.port, this.host, () => {
      console.log(`Gateway HTTP Server running at http://${this.host}:${this.port}/`);
      if (options?.callback) {
        options.callback(this.server);
      }
    });
  }

  async tryConnectToIPCServer() {
    try {
      const ipcClient = await this.getIPCSocketClient();
      return ipcClient;
    } catch (e) {
      // console.log(e);
      return false;
    }
  }

  async getIPCSocketClient() {
    return await IPCSocketClient.getConnection(this.socketPath);
  }

  close() {
    this.server?.close();
    this.wsServer?.close();
  }
}
