import express = require('express')
import cors = require('cors')
import { Mutex } from 'async-mutex'
import slpMiddleware from './slpMiddleware'
import errorMessages from './errorMessages'
import Postage from './postage/Postage'
import TokenPriceFeeder from './tokenPriceFeeder/TokenPriceFeeder'
import { config } from './serverConfig'

const app: express.Application = express()
app.use(cors())
app.use(slpMiddleware)
const mutex = new Mutex()

config.priceFeeders.forEach(priceFeeder => {
    const tokenPriceFeeder = new TokenPriceFeeder(
        config.postage,
        100,
        priceFeeder.tokenId,
        new priceFeeder.feederClass(),
        priceFeeder.useInitialStampRateAsMin
    )
    tokenPriceFeeder.run()
})


app.get('/postage', function(req: express.Request, res: express.Response): void {
    const postage = new Postage(config)
    res.send(postage.getRates())
})

app.post('/postage', async function(req: any, res: express.Response) {
    try {
        if (!req.is('application/simpleledger-payment')) {
            res.status(400).send(errorMessages.UNSUPPORTED_CONTENT_TYPE)
            return
        }
        const release = await mutex.acquire()
        try {
            const postage = new Postage(config)
            const serializedPaymentAck = await postage.addStampsToTxAndBroadcast(req.raw)
            res.status(200).send(serializedPaymentAck)
        } finally {
            release()
        }
    } catch (e) {
        console.error(e)
        if (Object.values(errorMessages).includes(e.message)) {
            res.status(400).send(e.message)
        } else {
            res.status(500).send(e.message)
        }
    }
})

app.listen(config.port, async () => {
    const postage = new Postage(config)
    const cashAddress = postage.hdNode.privateKey.toAddress().toString()
    console.log(`Send stamps to: ${cashAddress}`)

    const stampGenerationIntervalInMinutes = 30
    setInterval(postage.generateStamps, 1000 * 60 * stampGenerationIntervalInMinutes)
    postage.generateStamps()

    console.log(`Post Office listening on port ${config.port}!`)
})