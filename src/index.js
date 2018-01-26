var EventProcessor = require('./EventProcessor');
var EventEmitter = require('./EventEmitter');
var EventSerializer = require('./EventSerializer');
var GoalTracker = require('./GoalTracker');
var Stream = require('./Stream');
var Requestor = require('./Requestor');
var Identity = require('./Identity');
var utils = require('./utils');
var messages = require('./messages');
var store = require('./store');
var errors = require('./errors');

var flags = {};
var environment;
var events;
var requestor;
var stream;
var sendEvents;
var emitter;
var hash;
var ident;
var baseUrl;
var eventsUrl;
var streamUrl;
var goalTracker;
var useLocalStorage;
var localStorageKey;
var goals;

var readyEvent = 'ready';
var changeEvent = 'change';

var flushInterval = 2000;

var seenRequests = {};

function sendIdentifyEvent(user) {
  enqueueEvent({
    kind: 'identify',
    key: user.key,
    user: user,
    creationDate: (new Date()).getTime()
  });
}

function sendFlagEvent(key, value, defaultValue) {
  var user = ident.getUser();
  var cacheKey = JSON.stringify(value) + (user && user.key ? user.key : '') + key;
  var now = new Date();
  var cached = seenRequests[cacheKey];

  if (cached && (now - cached) < 300000 /* five minutes, in ms */) {
    return;
  }

  seenRequests[cacheKey] = now;

  enqueueEvent({
    kind: 'feature',
    key: key,
    user: user,
    value: value,
    'default': defaultValue,
    creationDate: now.getTime()
  });
}

function sendGoalEvent(kind, goal) {
  var event = {
    kind: kind,
    key: goal.key,
    data: null,
    url: window.location.href,
    creationDate: (new Date()).getTime()
  };

  if (kind === 'click') {
    event.selector = goal.selector;
  }

  return enqueueEvent(event);
}

function identify(user, hash, onDone) {
  return utils.wrapPromiseCallback(new Promise((function(resolve, reject) {
    ident.setUser(user);
    requestor.fetchFlagSettings(ident.getUser(), hash, function(err, settings) {
      if (err) {
        emitter.maybeReportError(new errors.LDFlagFetchError(messages.errorFetchingFlags(err)));
        return reject(err)
      }
      if (settings) {
        updateSettings(settings);
      }
      resolve(settings);
    });
  }).bind(this)), onDone);
}

function waitUntilReady() {
  return new Promise(function(resolve) {
    client.on('ready', resolve);
  });
}

function variation(key, defaultValue) {
  var value;

  if (flags && flags.hasOwnProperty(key)) {
    value = flags[key] === null ? defaultValue : flags[key];
  } else {
    value = defaultValue;
  }

  sendFlagEvent(key, value, defaultValue);

  return value;
}

function enqueueEvent(event) {
  if (sendEvents && !doNotTrack()) {
    events.enqueue(event);
  }
}

function doNotTrack() {
  var flag;
  if (navigator && navigator.doNotTrack !== undefined) {
    flag = navigator.doNotTrack;    // FF, Chrome
  } else if (navigator && navigator.msDoNotTrack !== undefined) {
    flag = navigator.msDoNotTrack;  // IE 9/10
  } else {
    flag = window.doNotTrack;       // IE 11+, Safari
  }
  return flag === '1' || flag === 'yes';
}

function allFlags() {
  var results = {};

  if (!flags) { return results; }

  for (var key in flags) {
    if (flags.hasOwnProperty(key)) {
      results[key] = variation(key, null);
    }
  }

  return results;
}

function customEventExists(key) {
  if (!goals || goals.length === 0) { return false; }

  for (var i=0 ; i < goals.length ; i++) {
    if (goals[i].kind === 'custom' && goals[i].key === key) {
      return true;
    }
  }

  return false;
}

function track(key, data) {
  if (typeof key !== 'string') {
    emitter.maybeReportError(new errors.LDInvalidEventKeyError(messages.unknownCustomEventKey(key)));
    return;
  }

  // Validate key if we have goals
  if (!!goals && !customEventExists(key)) {
    console.warn(messages.unknownCustomEventKey(key));
  }

  enqueueEvent({
    kind: 'custom',
    key: key,
    data: data,
    url: window.location.href,
    creationDate: (new Date()).getTime()
  });
}

function connectStream() {
  stream.connect(function() {
    requestor.fetchFlagSettings(ident.getUser(), hash, function(err, settings) {
      if (err) {
        emitter.maybeReportError(new errors.LDFlagFetchError(messages.errorFetchingFlags(err)));
      }
      updateSettings(settings);
    });
  });
}

function updateSettings(settings) {
  var changes;
  var keys;

  if (!settings) { return; }

  changes = utils.modifications(flags, settings);
  keys = Object.keys(changes);

  flags = settings;

  if (useLocalStorage) {
    store.clear(localStorageKey);
    localStorageKey = lsKey(environment, ident.getUser());
    store.set(localStorageKey, JSON.stringify(flags));
  }

  if (keys.length > 0) {
    keys.forEach(function(key) {
      emitter.emit(changeEvent + ':' + key, changes[key].current, changes[key].previous);
    });

    emitter.emit(changeEvent, changes);

    keys.forEach(function(key) {
      sendFlagEvent(key, changes[key].current);
    });
  }
}

function on(event, handler, context) {
  if (event.substr(0, changeEvent.length) === changeEvent) {
    if (!stream.isConnected()) {
      connectStream();
    }
    emitter.on.apply(emitter, [event, handler, context]);
  } else {
    emitter.on.apply(emitter, Array.prototype.slice.call(arguments));
  }
}

function off() {
  emitter.off.apply(emitter, Array.prototype.slice.call(arguments));
}

function handleMessage(event) {
  if (event.origin !== baseUrl) { return; }
  if (event.data.type === 'SYN') {
    window.editorClientBaseUrl = baseUrl;
    var editorTag = document.createElement('script');
    editorTag.type = 'text/javascript';
    editorTag.async = true;
    editorTag.src = baseUrl + event.data.editorClientUrl;
    var s = document.getElementsByTagName('script')[0];
    s.parentNode.insertBefore(editorTag, s);
  }
}

var client = {
  waitUntilReady: waitUntilReady,
  identify: identify,
  variation: variation,
  track: track,
  on: on,
  off: off,
  allFlags: allFlags
};

function lsKey(env, user) {
  var key = '';
  if (user) {
    key = hash || utils.btoa(JSON.stringify(user));
  }
  return 'ld:' + env + ':' + key;
}

function initialize(env, user, options) {
  options = options || {};
  environment = env;
  flags = typeof(options.bootstrap) === 'object' ? options.bootstrap : {};
  hash = options.hash;
  baseUrl = options.baseUrl || 'https://app.launchdarkly.com';
  eventsUrl = options.eventsUrl || 'https://events.launchdarkly.com';
  streamUrl = options.streamUrl || 'https://clientstream.launchdarkly.com';
  stream = Stream(streamUrl, environment);
  events = EventProcessor(eventsUrl + '/a/' + environment + '.gif', EventSerializer(options));
  sendEvents = (typeof options.sendEvents === 'undefined') ? true : config.sendEvents;
  emitter = EventEmitter();
  ident = Identity(user, sendIdentifyEvent);
  requestor = Requestor(baseUrl, environment, options.useReport);
  localStorageKey = lsKey(environment, ident.getUser());

  if (!env) {
    utils.onNextTick(function() {
      emitter.maybeReportError(new errors.LDInvalidEnvironmentIdError(messages.environmentNotSpecified()));
    })
  }

  if (!user) {
    utils.onNextTick(function() {
      emitter.maybeReportError(new errors.LDInvalidUserError(messages.userNotSpecified()));
    });
  }
  else if (!user.key) {
    utils.onNextTick(function() {
      emitter.maybeReportError(new errors.LDInvalidUserError(messages.invalidUser()));
    });
  }

  if (typeof options.bootstrap === 'object') {
    utils.onNextTick(function() { emitter.emit(readyEvent); });
  }
  else if (typeof(options.bootstrap) === 'string' && options.bootstrap.toUpperCase() === 'LOCALSTORAGE' && typeof(Storage) !== 'undefined') {
    useLocalStorage = true;

    // check if localStorage data is corrupted, if so clear it
    try {
      flags = JSON.parse(store.get(localStorageKey));
    } catch (error) {
      store.clear(localStorageKey);
    }

    if (flags === null) {
      requestor.fetchFlagSettings(ident.getUser(), hash, function(err, settings) {
        if (err) {
          emitter.maybeReportError(new errors.LDFlagFetchError(messages.errorFetchingFlags(err)));
        }
        flags = settings;
        settings && store.set(localStorageKey, JSON.stringify(flags));
        emitter.emit(readyEvent);
      });
    } else {
      // We're reading the flags from local storage. Signal that we're ready,
      // then update localStorage for the next page load. We won't signal changes or update
      // the in-memory flags unless you subscribe for changes
      utils.onNextTick(function() { emitter.emit(readyEvent); });
      requestor.fetchFlagSettings(ident.getUser(), hash, function(err, settings) {
        if (err) {
          emitter.maybeReportError(new errors.LDFlagFetchError(messages.errorFetchingFlags(err)));
        }
        settings && store.set(localStorageKey, JSON.stringify(settings));
      });
    }
  }
  else {
    requestor.fetchFlagSettings(ident.getUser(), hash, function(err, settings) {
      if (err) {
        emitter.maybeReportError(new errors.LDFlagFetchError(messages.errorFetchingFlags(err)));
      }
      flags = settings;
      emitter.emit(readyEvent);
    });
  }

  requestor.fetchGoals(function(err, g) {
    if (err) {
      emitter.maybeReportError(new errors.LDUnexpectedResponseError('Error fetching goals: ' + err.message ? err.message : err));
    }
    if (g && g.length > 0) {
      goals = g;
      goalTracker = GoalTracker(goals, sendGoalEvent);
    }
  });

  function start() {
    if(sendEvents) {
      setTimeout(function tick() {
        events.flush(ident.getUser());
        setTimeout(tick, flushInterval);
      }, flushInterval);
    }
  }

  if (document.readyState !== 'complete') {
    window.addEventListener('load', start);
  } else {
    start();
  }

  window.addEventListener('beforeunload', function() {
    events.flush(ident.getUser(), true);
  });

  function refreshGoalTracker() {
    if (goalTracker) {
      goalTracker.dispose();
    }
    if (goals && goals.length) {
      goalTracker = GoalTracker(goals, sendGoalEvent);
    }
  }

  if (goals && goals.length > 0) {
    if (!!(window.history && history.pushState)) {
      window.addEventListener('popstate', refreshGoalTracker);
    } else {
      window.addEventListener('hashchange', refreshGoalTracker);
    }
  }

  window.addEventListener('message', handleMessage);

  return client;
}

module.exports = {
  initialize: initialize
};

if(typeof VERSION !== 'undefined') {
  module.exports.version = VERSION;
}
