import path from 'path';
import express from 'express';
import rateLimit from 'express-rate-limit';
import cors = require('cors')
import { Mutex } from 'async-mutex';
import ErrorMessages from './ErrorMessages';
import Postage from './Postage';
import { Config } from './Config';
import { Log } from './Log';
import BCHDNetwork from './Network/BCHDNetwork';


const slpMiddleware = (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    if (! req.is('application/simpleledger-payment')) {
        return next();
    }

    const data: Buffer[] = [];

    req.on('data', chunk => {
        data.push(chunk);
    });

    req.on('end', () => {
        if (data.length <= 0) {
            return next();
        }
        const endData = Buffer.concat(data);
        // @ts-ignore
        req.raw = endData;
        next();
    });
};

const limiter = rateLimit({
    windowMs: Config.server.limitEvery,
    max: Config.server.limitMaxReqs
});

const app: express.Application = express();
app.use(cors());
app.use(slpMiddleware);
app.use(limiter);

const network = new BCHDNetwork(Config);
const postage = new Postage(Config, network);

const mutex = new Mutex();

app.get('/', function(req: express.Request, res: express.Response) {
    res.sendFile(path.join(__dirname + '/../public/index.html'));
});

app.get('/postage', function(req: express.Request, res: express.Response): void {
    res.send(Config.postageRate);
});

app.get('/swap', function(req: express.Request, res: express.Response): void {
    res.send(Config.swapRate);
});

app.post('/postage', async function(req: express.Request, res: express.Response): Promise<void> {
    try {
        if (! req.is('application/simpleledger-payment')) {
            res.status(400).send(ErrorMessages.UNSUPPORTED_CONTENT_TYPE);
            return;
        }
        const release = await mutex.acquire();
        try {
            // @ts-ignore
            const serializedPaymentAck = await postage.addStampsToTxAndBroadcast(req.raw);
            res.status(200).send(serializedPaymentAck);
        } finally {
            release();
        }
    } catch (e) {
        const msg = e.message || e.error || e;
        Log.error(msg);

        if (Object.values(ErrorMessages).includes(e.message)) {
            res.status(400).send(msg);
        } else {
            res.status(500).send(msg);
        }
    }
});

/*
 * INITIALIZE SERVER
 */
(async (): Promise<void> => {

    Log.info(`Send stamps to: ${postage.getDepositAddress().toString()}`);
    Log.info(`Found ${(await network.fetchUTXOs(postage.getDepositAddress())).length} stamps`);

    setInterval(
        () => postage.generateStamps(),
        1500 * Config.postage.stampGenerationIntervalSeconds
    );
    postage.generateStamps();

    // const server = app.listen(Config.server.port, Config.server.host, async () => {
    const server = app.listen(process.env.PORT, async () => {
        Log.info(`Post Office listening ${Config.server.host}:${Config.server.port}`);
    });

    let connections = [];
    server.on('connection', (connection): void => {
        connections.push(connection);
        connection.on('close', () => connections = connections.filter(curr => curr !== connection));
    });

    function shutDown(): void {
        Log.info('Received kill signal, shutting down gracefully');
        server.close(() => {
            Log.info('Closed out remaining connections');
            process.exit(0);
        });

        setTimeout(() => {
            Log.error('Could not close connections in time, forcefully shutting down');
            process.exit(1);
        }, 10000);

        connections.forEach(curr => curr.end());
        setTimeout(() => connections.forEach(curr => curr.destroy()), 5000);
    }

    process.on('SIGTERM', shutDown);
    process.on('SIGINT', shutDown);
})()