const
  argv          = require('yargs')                                  // "yargs" is a command line argument module
                  .demand('connection')                             // 'connection' is the path to the node_redis style connection object
                  .argv,                                            // return the values in an object
  async         = require('async'),
  redis         = require('redis'),                                 // node_redis to manage the redis connection
  express       = require('express'),                               // express web framework
  app           = express(),                                        // init express
  expressWs     = require('express-ws')(app),                       // extend express to be able to handle web sockets
  connection    = require(argv.connection),                         // import the JSON from the arguments
  streamProcessor
                = require('./streamProcessor.node.js'),             // handle incoming redis streams
  EventEmitter  = require('eventemitter2').EventEmitter2,           // `eventemitter2` had some more nicer things than the standard (and it's faster!)

  evEmitter     = new EventEmitter({                
    wildcard    : true                                              // `eventemitter2` allows for wildcars in the event names. This would be useful for a multiplexed graph later on
  });

redis.add_command('xread');                                         // `xread` is only in Redis unstable, so I need to add it in until it's integrated into the client library

const
  streamClient = redis.createClient(connection),                    // create the client after adding in xread
  elementProcessors = {                                             // you can add in multiple streams here
    'temp-track'    : ((el) => (done) => {
        let
          streamSequence  = el[0];                                  // the structure of the stream output is rather deep, but 0th element is the ts based sequence
          timestamp       = Number(streamSequence.split('-')[0]),   // the sequence isn't just a timestamp, but also an additional number in case two events occur in the same ms
          temperature     = Number(el[1][1]);                       // this will actually be a temperature

        evEmitter.emit('temperature',                               // emit an internal event that we can push out to the web socekt
          [timestamp,temperature].join(':')                         // we'll make a plain text structure
        );
        done();
      }
    )
  };

streamProcessor(                                                    // this can handle many, many incoming streams, but we'll just do a single one for the demo
  streamClient,                                                     // pass in the redis client
  Object.keys(elementProcessors),                                   // these are the streams we're watching
  elementProcessors                                                 // and how the streams are intercepted and subsquently handled
);

                                                                    // this function is flexible to be generalized, but we use it only once for the demo
function streamToWebSocket(server,eventName,route,processFn,additionalFn) {
  server.ws(route,(ws,req) => {                                     // this is express handling a websocket connection at a URL
    let proxyToWs = function(data) {
      if (ws.readyState === 1) {                                    // opened and ready
        processFn.bind(this)(ws,req,data);                          // bind the websocket to processing function from the stream processor
      }
    };
    evEmitter.on(eventName, proxyToWs);                             // then when we get a event, we can just bounce it back out to the web socket
    additionalFn ? additionalFn(ws,req) : {};
  
    ws.on('close',() => {                                           // deal with closed connections
      evEmitter.off(eventName,proxyToWs);
    });
  });

  return server;
}
                                                                    // actually get to the meat of handling out temperature websocket route
streamToWebSocket(app,'temperature','/temperature', function(ws,req,data) {
  ws.send(JSON.stringify(data));                                    // simply send out the data (effectively proxy). You could do more interesting things here
});

app
  .use(express.static('static'))                                    // static file server for the index file
  .listen(4379);                                                    // listen at a port
