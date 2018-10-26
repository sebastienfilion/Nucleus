# Nucleus

Nucleus is a flexible library that offers tools to implement a distributed micro-service(-like) architecture in NodeJS.

[![npm version](https://badge.fury.io/js/idex.nucleus.svg)](https://badge.fury.io/js/idex.nucleus)

IDEX Nucleus Core is the framework to build flexible, scalable and structured back-end architecture. 
It includes:  

  * Structured dataflow;  
  * Inter-engine communication protocol;   
  * Content persistence API;  
  * Content relationship powered by Graph technology;  
  * Intuitive workflow;

## Getting started

### NPM

You can quickly and easily install IDEX Nucleus Core to your project using NPM.
Make sure to install [NodeJS and NPM](https://nodejs.org/en/download/) before;

```bash
$ npm install @idex/nucleus.core
```

### Redis

The communication of Nucleus is heavily based on Redis, first and for all make sure to install Redis. [Redis installation guide](https://redis.io/topics/quickstart)

For Nucleus to work correctly, you need to make sure that your server can use keyspace notification.  
You can test that keyspace notification is enabled using the `redis-cli`:

```bash
$ redis-cli
127.0.0.1:6379> CONFIG GET notify-keyspace-events
1) "notify-keyspace-events"
2) "AKE"
```

If it isn't enabled you can enable it manually using the `CONFIG SET` command:

```bash
$ redis-cli
127.0.0.1:6379> CONFIG SET notify-keyspace-events AKE
OK
```

or, you can copy the `redis.conf` file from Nucleus root directory into your project.

```bash
$ redis-server PATH_TO_PROJECT/redis.conf
```

## Nucleus Engine

The Nucleus engine (engine for short) is used to interact with the communication layer. It is task to publish/handle actions
and events.

### Create a new Engine

You can create an engine by simply instantiating the `NucleusEngine` class:

```javascript
const { NucleusEngine } = require('idex.nucleus');

const $engine = new NucleusEngine('Test');

// Here, `$engine` is a proxy: it is both a valid promise and the instantiated Nucleus engine.

$engine
      // The engine is ready to be used.
    .then(() => {
      // Do something with the engine.
    })
    // Something happened during the initialization of the engine.
    .catch(console.error);
```

Checkout the tutorials for your first steps:
  1. [Create a basic engine](https://github.com/sebastienfilion/idex.nucleus/wiki/Tutorial-Create-a-basic-engine)
  2. [Create a basic API with public Gateway](https://github.com/sebastienfilion/idex.nucleus/wiki/Tutorial-Create-a-basic-API-with-public-gateway)
  3. [Create a persistent storage API](https://github.com/sebastienfilion/idex.nucleus/wiki/Tutorial-Create-a-persistent-storage-API)


## License

MIT License

Copyright (c) 2018 Sebastien Filion

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Contributing 

  1. Fork it (https://github.com/sebastienfilion/idex.nucleus/fork)
  2. Create your feature branch (`git checkout -b feature/foo-bar`)
  3. Commit your changes (`git commit -am 'Add some fooBar'`)
  4. Push to the branch (`git push origin feature/food-bar`)
  5. Create a new Pull Request
  
Please use the following namespace convention to name you branch:

  * `feature/[:issue-number/]:feature-name` Marks a branch that introduce a new feature. Add the issue number if it is 
  available. ie: `feature/#24/emoji-action-name`;
  * `bugfix/[:issue-number/]:bug-name` Marks a branch that fixes a bug. Add the issue number if it is available. ie: 
  `bugfix/#13/engine-cleanup`;
  * `change/[:issue-number/]:change-name` Marks a branch that makes a change to the codebase or documentation. Add the 
  issue number if it is available. ie: `change/update-release-note`;
