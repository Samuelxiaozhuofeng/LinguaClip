var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/react/cjs/react.development.js
var require_react_development = __commonJS({
  "node_modules/react/cjs/react.development.js"(exports, module) {
    "use strict";
    (function() {
      function defineDeprecationWarning(methodName, info) {
        Object.defineProperty(Component.prototype, methodName, {
          get: function() {
            console.warn(
              "%s(...) is deprecated in plain JavaScript React classes. %s",
              info[0],
              info[1]
            );
          }
        });
      }
      function getIteratorFn(maybeIterable) {
        if (null === maybeIterable || "object" !== typeof maybeIterable)
          return null;
        maybeIterable = MAYBE_ITERATOR_SYMBOL && maybeIterable[MAYBE_ITERATOR_SYMBOL] || maybeIterable["@@iterator"];
        return "function" === typeof maybeIterable ? maybeIterable : null;
      }
      function warnNoop(publicInstance, callerName) {
        publicInstance = (publicInstance = publicInstance.constructor) && (publicInstance.displayName || publicInstance.name) || "ReactClass";
        var warningKey = publicInstance + "." + callerName;
        didWarnStateUpdateForUnmountedComponent[warningKey] || (console.error(
          "Can't call %s on a component that is not yet mounted. This is a no-op, but it might indicate a bug in your application. Instead, assign to `this.state` directly or define a `state = {};` class property with the desired state in the %s component.",
          callerName,
          publicInstance
        ), didWarnStateUpdateForUnmountedComponent[warningKey] = true);
      }
      function Component(props, context, updater) {
        this.props = props;
        this.context = context;
        this.refs = emptyObject;
        this.updater = updater || ReactNoopUpdateQueue;
      }
      function ComponentDummy() {
      }
      function PureComponent(props, context, updater) {
        this.props = props;
        this.context = context;
        this.refs = emptyObject;
        this.updater = updater || ReactNoopUpdateQueue;
      }
      function noop() {
      }
      function testStringCoercion(value) {
        return "" + value;
      }
      function checkKeyStringCoercion(value) {
        try {
          testStringCoercion(value);
          var JSCompiler_inline_result = false;
        } catch (e) {
          JSCompiler_inline_result = true;
        }
        if (JSCompiler_inline_result) {
          JSCompiler_inline_result = console;
          var JSCompiler_temp_const = JSCompiler_inline_result.error;
          var JSCompiler_inline_result$jscomp$0 = "function" === typeof Symbol && Symbol.toStringTag && value[Symbol.toStringTag] || value.constructor.name || "Object";
          JSCompiler_temp_const.call(
            JSCompiler_inline_result,
            "The provided key is an unsupported type %s. This value must be coerced to a string before using it here.",
            JSCompiler_inline_result$jscomp$0
          );
          return testStringCoercion(value);
        }
      }
      function getComponentNameFromType(type) {
        if (null == type) return null;
        if ("function" === typeof type)
          return type.$$typeof === REACT_CLIENT_REFERENCE ? null : type.displayName || type.name || null;
        if ("string" === typeof type) return type;
        switch (type) {
          case REACT_FRAGMENT_TYPE:
            return "Fragment";
          case REACT_PROFILER_TYPE:
            return "Profiler";
          case REACT_STRICT_MODE_TYPE:
            return "StrictMode";
          case REACT_SUSPENSE_TYPE:
            return "Suspense";
          case REACT_SUSPENSE_LIST_TYPE:
            return "SuspenseList";
          case REACT_ACTIVITY_TYPE:
            return "Activity";
        }
        if ("object" === typeof type)
          switch ("number" === typeof type.tag && console.error(
            "Received an unexpected object in getComponentNameFromType(). This is likely a bug in React. Please file an issue."
          ), type.$$typeof) {
            case REACT_PORTAL_TYPE:
              return "Portal";
            case REACT_CONTEXT_TYPE:
              return type.displayName || "Context";
            case REACT_CONSUMER_TYPE:
              return (type._context.displayName || "Context") + ".Consumer";
            case REACT_FORWARD_REF_TYPE:
              var innerType = type.render;
              type = type.displayName;
              type || (type = innerType.displayName || innerType.name || "", type = "" !== type ? "ForwardRef(" + type + ")" : "ForwardRef");
              return type;
            case REACT_MEMO_TYPE:
              return innerType = type.displayName || null, null !== innerType ? innerType : getComponentNameFromType(type.type) || "Memo";
            case REACT_LAZY_TYPE:
              innerType = type._payload;
              type = type._init;
              try {
                return getComponentNameFromType(type(innerType));
              } catch (x) {
              }
          }
        return null;
      }
      function getTaskName(type) {
        if (type === REACT_FRAGMENT_TYPE) return "<>";
        if ("object" === typeof type && null !== type && type.$$typeof === REACT_LAZY_TYPE)
          return "<...>";
        try {
          var name = getComponentNameFromType(type);
          return name ? "<" + name + ">" : "<...>";
        } catch (x) {
          return "<...>";
        }
      }
      function getOwner() {
        var dispatcher = ReactSharedInternals.A;
        return null === dispatcher ? null : dispatcher.getOwner();
      }
      function UnknownOwner() {
        return Error("react-stack-top-frame");
      }
      function hasValidKey(config) {
        if (hasOwnProperty.call(config, "key")) {
          var getter = Object.getOwnPropertyDescriptor(config, "key").get;
          if (getter && getter.isReactWarning) return false;
        }
        return void 0 !== config.key;
      }
      function defineKeyPropWarningGetter(props, displayName) {
        function warnAboutAccessingKey() {
          specialPropKeyWarningShown || (specialPropKeyWarningShown = true, console.error(
            "%s: `key` is not a prop. Trying to access it will result in `undefined` being returned. If you need to access the same value within the child component, you should pass it as a different prop. (https://react.dev/link/special-props)",
            displayName
          ));
        }
        warnAboutAccessingKey.isReactWarning = true;
        Object.defineProperty(props, "key", {
          get: warnAboutAccessingKey,
          configurable: true
        });
      }
      function elementRefGetterWithDeprecationWarning() {
        var componentName = getComponentNameFromType(this.type);
        didWarnAboutElementRef[componentName] || (didWarnAboutElementRef[componentName] = true, console.error(
          "Accessing element.ref was removed in React 19. ref is now a regular prop. It will be removed from the JSX Element type in a future release."
        ));
        componentName = this.props.ref;
        return void 0 !== componentName ? componentName : null;
      }
      function ReactElement(type, key, props, owner, debugStack, debugTask) {
        var refProp = props.ref;
        type = {
          $$typeof: REACT_ELEMENT_TYPE,
          type,
          key,
          props,
          _owner: owner
        };
        null !== (void 0 !== refProp ? refProp : null) ? Object.defineProperty(type, "ref", {
          enumerable: false,
          get: elementRefGetterWithDeprecationWarning
        }) : Object.defineProperty(type, "ref", { enumerable: false, value: null });
        type._store = {};
        Object.defineProperty(type._store, "validated", {
          configurable: false,
          enumerable: false,
          writable: true,
          value: 0
        });
        Object.defineProperty(type, "_debugInfo", {
          configurable: false,
          enumerable: false,
          writable: true,
          value: null
        });
        Object.defineProperty(type, "_debugStack", {
          configurable: false,
          enumerable: false,
          writable: true,
          value: debugStack
        });
        Object.defineProperty(type, "_debugTask", {
          configurable: false,
          enumerable: false,
          writable: true,
          value: debugTask
        });
        Object.freeze && (Object.freeze(type.props), Object.freeze(type));
        return type;
      }
      function cloneAndReplaceKey(oldElement, newKey) {
        newKey = ReactElement(
          oldElement.type,
          newKey,
          oldElement.props,
          oldElement._owner,
          oldElement._debugStack,
          oldElement._debugTask
        );
        oldElement._store && (newKey._store.validated = oldElement._store.validated);
        return newKey;
      }
      function validateChildKeys(node) {
        isValidElement(node) ? node._store && (node._store.validated = 1) : "object" === typeof node && null !== node && node.$$typeof === REACT_LAZY_TYPE && ("fulfilled" === node._payload.status ? isValidElement(node._payload.value) && node._payload.value._store && (node._payload.value._store.validated = 1) : node._store && (node._store.validated = 1));
      }
      function isValidElement(object) {
        return "object" === typeof object && null !== object && object.$$typeof === REACT_ELEMENT_TYPE;
      }
      function escape(key) {
        var escaperLookup = { "=": "=0", ":": "=2" };
        return "$" + key.replace(/[=:]/g, function(match) {
          return escaperLookup[match];
        });
      }
      function getElementKey(element, index) {
        return "object" === typeof element && null !== element && null != element.key ? (checkKeyStringCoercion(element.key), escape("" + element.key)) : index.toString(36);
      }
      function resolveThenable(thenable) {
        switch (thenable.status) {
          case "fulfilled":
            return thenable.value;
          case "rejected":
            throw thenable.reason;
          default:
            switch ("string" === typeof thenable.status ? thenable.then(noop, noop) : (thenable.status = "pending", thenable.then(
              function(fulfilledValue) {
                "pending" === thenable.status && (thenable.status = "fulfilled", thenable.value = fulfilledValue);
              },
              function(error) {
                "pending" === thenable.status && (thenable.status = "rejected", thenable.reason = error);
              }
            )), thenable.status) {
              case "fulfilled":
                return thenable.value;
              case "rejected":
                throw thenable.reason;
            }
        }
        throw thenable;
      }
      function mapIntoArray(children, array, escapedPrefix, nameSoFar, callback) {
        var type = typeof children;
        if ("undefined" === type || "boolean" === type) children = null;
        var invokeCallback = false;
        if (null === children) invokeCallback = true;
        else
          switch (type) {
            case "bigint":
            case "string":
            case "number":
              invokeCallback = true;
              break;
            case "object":
              switch (children.$$typeof) {
                case REACT_ELEMENT_TYPE:
                case REACT_PORTAL_TYPE:
                  invokeCallback = true;
                  break;
                case REACT_LAZY_TYPE:
                  return invokeCallback = children._init, mapIntoArray(
                    invokeCallback(children._payload),
                    array,
                    escapedPrefix,
                    nameSoFar,
                    callback
                  );
              }
          }
        if (invokeCallback) {
          invokeCallback = children;
          callback = callback(invokeCallback);
          var childKey = "" === nameSoFar ? "." + getElementKey(invokeCallback, 0) : nameSoFar;
          isArrayImpl(callback) ? (escapedPrefix = "", null != childKey && (escapedPrefix = childKey.replace(userProvidedKeyEscapeRegex, "$&/") + "/"), mapIntoArray(callback, array, escapedPrefix, "", function(c) {
            return c;
          })) : null != callback && (isValidElement(callback) && (null != callback.key && (invokeCallback && invokeCallback.key === callback.key || checkKeyStringCoercion(callback.key)), escapedPrefix = cloneAndReplaceKey(
            callback,
            escapedPrefix + (null == callback.key || invokeCallback && invokeCallback.key === callback.key ? "" : ("" + callback.key).replace(
              userProvidedKeyEscapeRegex,
              "$&/"
            ) + "/") + childKey
          ), "" !== nameSoFar && null != invokeCallback && isValidElement(invokeCallback) && null == invokeCallback.key && invokeCallback._store && !invokeCallback._store.validated && (escapedPrefix._store.validated = 2), callback = escapedPrefix), array.push(callback));
          return 1;
        }
        invokeCallback = 0;
        childKey = "" === nameSoFar ? "." : nameSoFar + ":";
        if (isArrayImpl(children))
          for (var i = 0; i < children.length; i++)
            nameSoFar = children[i], type = childKey + getElementKey(nameSoFar, i), invokeCallback += mapIntoArray(
              nameSoFar,
              array,
              escapedPrefix,
              type,
              callback
            );
        else if (i = getIteratorFn(children), "function" === typeof i)
          for (i === children.entries && (didWarnAboutMaps || console.warn(
            "Using Maps as children is not supported. Use an array of keyed ReactElements instead."
          ), didWarnAboutMaps = true), children = i.call(children), i = 0; !(nameSoFar = children.next()).done; )
            nameSoFar = nameSoFar.value, type = childKey + getElementKey(nameSoFar, i++), invokeCallback += mapIntoArray(
              nameSoFar,
              array,
              escapedPrefix,
              type,
              callback
            );
        else if ("object" === type) {
          if ("function" === typeof children.then)
            return mapIntoArray(
              resolveThenable(children),
              array,
              escapedPrefix,
              nameSoFar,
              callback
            );
          array = String(children);
          throw Error(
            "Objects are not valid as a React child (found: " + ("[object Object]" === array ? "object with keys {" + Object.keys(children).join(", ") + "}" : array) + "). If you meant to render a collection of children, use an array instead."
          );
        }
        return invokeCallback;
      }
      function mapChildren(children, func, context) {
        if (null == children) return children;
        var result = [], count = 0;
        mapIntoArray(children, result, "", "", function(child) {
          return func.call(context, child, count++);
        });
        return result;
      }
      function lazyInitializer(payload) {
        if (-1 === payload._status) {
          var ioInfo = payload._ioInfo;
          null != ioInfo && (ioInfo.start = ioInfo.end = performance.now());
          ioInfo = payload._result;
          var thenable = ioInfo();
          thenable.then(
            function(moduleObject) {
              if (0 === payload._status || -1 === payload._status) {
                payload._status = 1;
                payload._result = moduleObject;
                var _ioInfo = payload._ioInfo;
                null != _ioInfo && (_ioInfo.end = performance.now());
                void 0 === thenable.status && (thenable.status = "fulfilled", thenable.value = moduleObject);
              }
            },
            function(error) {
              if (0 === payload._status || -1 === payload._status) {
                payload._status = 2;
                payload._result = error;
                var _ioInfo2 = payload._ioInfo;
                null != _ioInfo2 && (_ioInfo2.end = performance.now());
                void 0 === thenable.status && (thenable.status = "rejected", thenable.reason = error);
              }
            }
          );
          ioInfo = payload._ioInfo;
          if (null != ioInfo) {
            ioInfo.value = thenable;
            var displayName = thenable.displayName;
            "string" === typeof displayName && (ioInfo.name = displayName);
          }
          -1 === payload._status && (payload._status = 0, payload._result = thenable);
        }
        if (1 === payload._status)
          return ioInfo = payload._result, void 0 === ioInfo && console.error(
            "lazy: Expected the result of a dynamic import() call. Instead received: %s\n\nYour code should look like: \n  const MyComponent = lazy(() => import('./MyComponent'))\n\nDid you accidentally put curly braces around the import?",
            ioInfo
          ), "default" in ioInfo || console.error(
            "lazy: Expected the result of a dynamic import() call. Instead received: %s\n\nYour code should look like: \n  const MyComponent = lazy(() => import('./MyComponent'))",
            ioInfo
          ), ioInfo.default;
        throw payload._result;
      }
      function resolveDispatcher() {
        var dispatcher = ReactSharedInternals.H;
        null === dispatcher && console.error(
          "Invalid hook call. Hooks can only be called inside of the body of a function component. This could happen for one of the following reasons:\n1. You might have mismatching versions of React and the renderer (such as React DOM)\n2. You might be breaking the Rules of Hooks\n3. You might have more than one copy of React in the same app\nSee https://react.dev/link/invalid-hook-call for tips about how to debug and fix this problem."
        );
        return dispatcher;
      }
      function releaseAsyncTransition() {
        ReactSharedInternals.asyncTransitions--;
      }
      function enqueueTask(task) {
        if (null === enqueueTaskImpl)
          try {
            var requireString = ("require" + Math.random()).slice(0, 7);
            enqueueTaskImpl = (module && module[requireString]).call(
              module,
              "timers"
            ).setImmediate;
          } catch (_err) {
            enqueueTaskImpl = function(callback) {
              false === didWarnAboutMessageChannel && (didWarnAboutMessageChannel = true, "undefined" === typeof MessageChannel && console.error(
                "This browser does not have a MessageChannel implementation, so enqueuing tasks via await act(async () => ...) will fail. Please file an issue at https://github.com/facebook/react/issues if you encounter this warning."
              ));
              var channel = new MessageChannel();
              channel.port1.onmessage = callback;
              channel.port2.postMessage(void 0);
            };
          }
        return enqueueTaskImpl(task);
      }
      function aggregateErrors(errors) {
        return 1 < errors.length && "function" === typeof AggregateError ? new AggregateError(errors) : errors[0];
      }
      function popActScope(prevActQueue, prevActScopeDepth) {
        prevActScopeDepth !== actScopeDepth - 1 && console.error(
          "You seem to have overlapping act() calls, this is not supported. Be sure to await previous act() calls before making a new one. "
        );
        actScopeDepth = prevActScopeDepth;
      }
      function recursivelyFlushAsyncActWork(returnValue, resolve, reject) {
        var queue = ReactSharedInternals.actQueue;
        if (null !== queue)
          if (0 !== queue.length)
            try {
              flushActQueue(queue);
              enqueueTask(function() {
                return recursivelyFlushAsyncActWork(returnValue, resolve, reject);
              });
              return;
            } catch (error) {
              ReactSharedInternals.thrownErrors.push(error);
            }
          else ReactSharedInternals.actQueue = null;
        0 < ReactSharedInternals.thrownErrors.length ? (queue = aggregateErrors(ReactSharedInternals.thrownErrors), ReactSharedInternals.thrownErrors.length = 0, reject(queue)) : resolve(returnValue);
      }
      function flushActQueue(queue) {
        if (!isFlushing) {
          isFlushing = true;
          var i = 0;
          try {
            for (; i < queue.length; i++) {
              var callback = queue[i];
              do {
                ReactSharedInternals.didUsePromise = false;
                var continuation = callback(false);
                if (null !== continuation) {
                  if (ReactSharedInternals.didUsePromise) {
                    queue[i] = callback;
                    queue.splice(0, i);
                    return;
                  }
                  callback = continuation;
                } else break;
              } while (1);
            }
            queue.length = 0;
          } catch (error) {
            queue.splice(0, i + 1), ReactSharedInternals.thrownErrors.push(error);
          } finally {
            isFlushing = false;
          }
        }
      }
      "undefined" !== typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ && "function" === typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.registerInternalModuleStart && __REACT_DEVTOOLS_GLOBAL_HOOK__.registerInternalModuleStart(Error());
      var REACT_ELEMENT_TYPE = Symbol.for("react.transitional.element"), REACT_PORTAL_TYPE = Symbol.for("react.portal"), REACT_FRAGMENT_TYPE = Symbol.for("react.fragment"), REACT_STRICT_MODE_TYPE = Symbol.for("react.strict_mode"), REACT_PROFILER_TYPE = Symbol.for("react.profiler"), REACT_CONSUMER_TYPE = Symbol.for("react.consumer"), REACT_CONTEXT_TYPE = Symbol.for("react.context"), REACT_FORWARD_REF_TYPE = Symbol.for("react.forward_ref"), REACT_SUSPENSE_TYPE = Symbol.for("react.suspense"), REACT_SUSPENSE_LIST_TYPE = Symbol.for("react.suspense_list"), REACT_MEMO_TYPE = Symbol.for("react.memo"), REACT_LAZY_TYPE = Symbol.for("react.lazy"), REACT_ACTIVITY_TYPE = Symbol.for("react.activity"), MAYBE_ITERATOR_SYMBOL = Symbol.iterator, didWarnStateUpdateForUnmountedComponent = {}, ReactNoopUpdateQueue = {
        isMounted: function() {
          return false;
        },
        enqueueForceUpdate: function(publicInstance) {
          warnNoop(publicInstance, "forceUpdate");
        },
        enqueueReplaceState: function(publicInstance) {
          warnNoop(publicInstance, "replaceState");
        },
        enqueueSetState: function(publicInstance) {
          warnNoop(publicInstance, "setState");
        }
      }, assign = Object.assign, emptyObject = {};
      Object.freeze(emptyObject);
      Component.prototype.isReactComponent = {};
      Component.prototype.setState = function(partialState, callback) {
        if ("object" !== typeof partialState && "function" !== typeof partialState && null != partialState)
          throw Error(
            "takes an object of state variables to update or a function which returns an object of state variables."
          );
        this.updater.enqueueSetState(this, partialState, callback, "setState");
      };
      Component.prototype.forceUpdate = function(callback) {
        this.updater.enqueueForceUpdate(this, callback, "forceUpdate");
      };
      var deprecatedAPIs = {
        isMounted: [
          "isMounted",
          "Instead, make sure to clean up subscriptions and pending requests in componentWillUnmount to prevent memory leaks."
        ],
        replaceState: [
          "replaceState",
          "Refactor your code to use setState instead (see https://github.com/facebook/react/issues/3236)."
        ]
      };
      for (fnName in deprecatedAPIs)
        deprecatedAPIs.hasOwnProperty(fnName) && defineDeprecationWarning(fnName, deprecatedAPIs[fnName]);
      ComponentDummy.prototype = Component.prototype;
      deprecatedAPIs = PureComponent.prototype = new ComponentDummy();
      deprecatedAPIs.constructor = PureComponent;
      assign(deprecatedAPIs, Component.prototype);
      deprecatedAPIs.isPureReactComponent = true;
      var isArrayImpl = Array.isArray, REACT_CLIENT_REFERENCE = Symbol.for("react.client.reference"), ReactSharedInternals = {
        H: null,
        A: null,
        T: null,
        S: null,
        actQueue: null,
        asyncTransitions: 0,
        isBatchingLegacy: false,
        didScheduleLegacyUpdate: false,
        didUsePromise: false,
        thrownErrors: [],
        getCurrentStack: null,
        recentlyCreatedOwnerStacks: 0
      }, hasOwnProperty = Object.prototype.hasOwnProperty, createTask = console.createTask ? console.createTask : function() {
        return null;
      };
      deprecatedAPIs = {
        react_stack_bottom_frame: function(callStackForError) {
          return callStackForError();
        }
      };
      var specialPropKeyWarningShown, didWarnAboutOldJSXRuntime;
      var didWarnAboutElementRef = {};
      var unknownOwnerDebugStack = deprecatedAPIs.react_stack_bottom_frame.bind(
        deprecatedAPIs,
        UnknownOwner
      )();
      var unknownOwnerDebugTask = createTask(getTaskName(UnknownOwner));
      var didWarnAboutMaps = false, userProvidedKeyEscapeRegex = /\/+/g, reportGlobalError = "function" === typeof reportError ? reportError : function(error) {
        if ("object" === typeof window && "function" === typeof window.ErrorEvent) {
          var event = new window.ErrorEvent("error", {
            bubbles: true,
            cancelable: true,
            message: "object" === typeof error && null !== error && "string" === typeof error.message ? String(error.message) : String(error),
            error
          });
          if (!window.dispatchEvent(event)) return;
        } else if ("object" === typeof process && "function" === typeof process.emit) {
          process.emit("uncaughtException", error);
          return;
        }
        console.error(error);
      }, didWarnAboutMessageChannel = false, enqueueTaskImpl = null, actScopeDepth = 0, didWarnNoAwaitAct = false, isFlushing = false, queueSeveralMicrotasks = "function" === typeof queueMicrotask ? function(callback) {
        queueMicrotask(function() {
          return queueMicrotask(callback);
        });
      } : enqueueTask;
      deprecatedAPIs = Object.freeze({
        __proto__: null,
        c: function(size) {
          return resolveDispatcher().useMemoCache(size);
        }
      });
      var fnName = {
        map: mapChildren,
        forEach: function(children, forEachFunc, forEachContext) {
          mapChildren(
            children,
            function() {
              forEachFunc.apply(this, arguments);
            },
            forEachContext
          );
        },
        count: function(children) {
          var n = 0;
          mapChildren(children, function() {
            n++;
          });
          return n;
        },
        toArray: function(children) {
          return mapChildren(children, function(child) {
            return child;
          }) || [];
        },
        only: function(children) {
          if (!isValidElement(children))
            throw Error(
              "React.Children.only expected to receive a single React element child."
            );
          return children;
        }
      };
      exports.Activity = REACT_ACTIVITY_TYPE;
      exports.Children = fnName;
      exports.Component = Component;
      exports.Fragment = REACT_FRAGMENT_TYPE;
      exports.Profiler = REACT_PROFILER_TYPE;
      exports.PureComponent = PureComponent;
      exports.StrictMode = REACT_STRICT_MODE_TYPE;
      exports.Suspense = REACT_SUSPENSE_TYPE;
      exports.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE = ReactSharedInternals;
      exports.__COMPILER_RUNTIME = deprecatedAPIs;
      exports.act = function(callback) {
        var prevActQueue = ReactSharedInternals.actQueue, prevActScopeDepth = actScopeDepth;
        actScopeDepth++;
        var queue = ReactSharedInternals.actQueue = null !== prevActQueue ? prevActQueue : [], didAwaitActCall = false;
        try {
          var result = callback();
        } catch (error) {
          ReactSharedInternals.thrownErrors.push(error);
        }
        if (0 < ReactSharedInternals.thrownErrors.length)
          throw popActScope(prevActQueue, prevActScopeDepth), callback = aggregateErrors(ReactSharedInternals.thrownErrors), ReactSharedInternals.thrownErrors.length = 0, callback;
        if (null !== result && "object" === typeof result && "function" === typeof result.then) {
          var thenable = result;
          queueSeveralMicrotasks(function() {
            didAwaitActCall || didWarnNoAwaitAct || (didWarnNoAwaitAct = true, console.error(
              "You called act(async () => ...) without await. This could lead to unexpected testing behaviour, interleaving multiple act calls and mixing their scopes. You should - await act(async () => ...);"
            ));
          });
          return {
            then: function(resolve, reject) {
              didAwaitActCall = true;
              thenable.then(
                function(returnValue) {
                  popActScope(prevActQueue, prevActScopeDepth);
                  if (0 === prevActScopeDepth) {
                    try {
                      flushActQueue(queue), enqueueTask(function() {
                        return recursivelyFlushAsyncActWork(
                          returnValue,
                          resolve,
                          reject
                        );
                      });
                    } catch (error$0) {
                      ReactSharedInternals.thrownErrors.push(error$0);
                    }
                    if (0 < ReactSharedInternals.thrownErrors.length) {
                      var _thrownError = aggregateErrors(
                        ReactSharedInternals.thrownErrors
                      );
                      ReactSharedInternals.thrownErrors.length = 0;
                      reject(_thrownError);
                    }
                  } else resolve(returnValue);
                },
                function(error) {
                  popActScope(prevActQueue, prevActScopeDepth);
                  0 < ReactSharedInternals.thrownErrors.length ? (error = aggregateErrors(
                    ReactSharedInternals.thrownErrors
                  ), ReactSharedInternals.thrownErrors.length = 0, reject(error)) : reject(error);
                }
              );
            }
          };
        }
        var returnValue$jscomp$0 = result;
        popActScope(prevActQueue, prevActScopeDepth);
        0 === prevActScopeDepth && (flushActQueue(queue), 0 !== queue.length && queueSeveralMicrotasks(function() {
          didAwaitActCall || didWarnNoAwaitAct || (didWarnNoAwaitAct = true, console.error(
            "A component suspended inside an `act` scope, but the `act` call was not awaited. When testing React components that depend on asynchronous data, you must await the result:\n\nawait act(() => ...)"
          ));
        }), ReactSharedInternals.actQueue = null);
        if (0 < ReactSharedInternals.thrownErrors.length)
          throw callback = aggregateErrors(ReactSharedInternals.thrownErrors), ReactSharedInternals.thrownErrors.length = 0, callback;
        return {
          then: function(resolve, reject) {
            didAwaitActCall = true;
            0 === prevActScopeDepth ? (ReactSharedInternals.actQueue = queue, enqueueTask(function() {
              return recursivelyFlushAsyncActWork(
                returnValue$jscomp$0,
                resolve,
                reject
              );
            })) : resolve(returnValue$jscomp$0);
          }
        };
      };
      exports.cache = function(fn) {
        return function() {
          return fn.apply(null, arguments);
        };
      };
      exports.cacheSignal = function() {
        return null;
      };
      exports.captureOwnerStack = function() {
        var getCurrentStack = ReactSharedInternals.getCurrentStack;
        return null === getCurrentStack ? null : getCurrentStack();
      };
      exports.cloneElement = function(element, config, children) {
        if (null === element || void 0 === element)
          throw Error(
            "The argument must be a React element, but you passed " + element + "."
          );
        var props = assign({}, element.props), key = element.key, owner = element._owner;
        if (null != config) {
          var JSCompiler_inline_result;
          a: {
            if (hasOwnProperty.call(config, "ref") && (JSCompiler_inline_result = Object.getOwnPropertyDescriptor(
              config,
              "ref"
            ).get) && JSCompiler_inline_result.isReactWarning) {
              JSCompiler_inline_result = false;
              break a;
            }
            JSCompiler_inline_result = void 0 !== config.ref;
          }
          JSCompiler_inline_result && (owner = getOwner());
          hasValidKey(config) && (checkKeyStringCoercion(config.key), key = "" + config.key);
          for (propName in config)
            !hasOwnProperty.call(config, propName) || "key" === propName || "__self" === propName || "__source" === propName || "ref" === propName && void 0 === config.ref || (props[propName] = config[propName]);
        }
        var propName = arguments.length - 2;
        if (1 === propName) props.children = children;
        else if (1 < propName) {
          JSCompiler_inline_result = Array(propName);
          for (var i = 0; i < propName; i++)
            JSCompiler_inline_result[i] = arguments[i + 2];
          props.children = JSCompiler_inline_result;
        }
        props = ReactElement(
          element.type,
          key,
          props,
          owner,
          element._debugStack,
          element._debugTask
        );
        for (key = 2; key < arguments.length; key++)
          validateChildKeys(arguments[key]);
        return props;
      };
      exports.createContext = function(defaultValue) {
        defaultValue = {
          $$typeof: REACT_CONTEXT_TYPE,
          _currentValue: defaultValue,
          _currentValue2: defaultValue,
          _threadCount: 0,
          Provider: null,
          Consumer: null
        };
        defaultValue.Provider = defaultValue;
        defaultValue.Consumer = {
          $$typeof: REACT_CONSUMER_TYPE,
          _context: defaultValue
        };
        defaultValue._currentRenderer = null;
        defaultValue._currentRenderer2 = null;
        return defaultValue;
      };
      exports.createElement = function(type, config, children) {
        for (var i = 2; i < arguments.length; i++)
          validateChildKeys(arguments[i]);
        i = {};
        var key = null;
        if (null != config)
          for (propName in didWarnAboutOldJSXRuntime || !("__self" in config) || "key" in config || (didWarnAboutOldJSXRuntime = true, console.warn(
            "Your app (or one of its dependencies) is using an outdated JSX transform. Update to the modern JSX transform for faster performance: https://react.dev/link/new-jsx-transform"
          )), hasValidKey(config) && (checkKeyStringCoercion(config.key), key = "" + config.key), config)
            hasOwnProperty.call(config, propName) && "key" !== propName && "__self" !== propName && "__source" !== propName && (i[propName] = config[propName]);
        var childrenLength = arguments.length - 2;
        if (1 === childrenLength) i.children = children;
        else if (1 < childrenLength) {
          for (var childArray = Array(childrenLength), _i = 0; _i < childrenLength; _i++)
            childArray[_i] = arguments[_i + 2];
          Object.freeze && Object.freeze(childArray);
          i.children = childArray;
        }
        if (type && type.defaultProps)
          for (propName in childrenLength = type.defaultProps, childrenLength)
            void 0 === i[propName] && (i[propName] = childrenLength[propName]);
        key && defineKeyPropWarningGetter(
          i,
          "function" === typeof type ? type.displayName || type.name || "Unknown" : type
        );
        var propName = 1e4 > ReactSharedInternals.recentlyCreatedOwnerStacks++;
        return ReactElement(
          type,
          key,
          i,
          getOwner(),
          propName ? Error("react-stack-top-frame") : unknownOwnerDebugStack,
          propName ? createTask(getTaskName(type)) : unknownOwnerDebugTask
        );
      };
      exports.createRef = function() {
        var refObject = { current: null };
        Object.seal(refObject);
        return refObject;
      };
      exports.forwardRef = function(render) {
        null != render && render.$$typeof === REACT_MEMO_TYPE ? console.error(
          "forwardRef requires a render function but received a `memo` component. Instead of forwardRef(memo(...)), use memo(forwardRef(...))."
        ) : "function" !== typeof render ? console.error(
          "forwardRef requires a render function but was given %s.",
          null === render ? "null" : typeof render
        ) : 0 !== render.length && 2 !== render.length && console.error(
          "forwardRef render functions accept exactly two parameters: props and ref. %s",
          1 === render.length ? "Did you forget to use the ref parameter?" : "Any additional parameter will be undefined."
        );
        null != render && null != render.defaultProps && console.error(
          "forwardRef render functions do not support defaultProps. Did you accidentally pass a React component?"
        );
        var elementType = { $$typeof: REACT_FORWARD_REF_TYPE, render }, ownName;
        Object.defineProperty(elementType, "displayName", {
          enumerable: false,
          configurable: true,
          get: function() {
            return ownName;
          },
          set: function(name) {
            ownName = name;
            render.name || render.displayName || (Object.defineProperty(render, "name", { value: name }), render.displayName = name);
          }
        });
        return elementType;
      };
      exports.isValidElement = isValidElement;
      exports.lazy = function(ctor) {
        ctor = { _status: -1, _result: ctor };
        var lazyType = {
          $$typeof: REACT_LAZY_TYPE,
          _payload: ctor,
          _init: lazyInitializer
        }, ioInfo = {
          name: "lazy",
          start: -1,
          end: -1,
          value: null,
          owner: null,
          debugStack: Error("react-stack-top-frame"),
          debugTask: console.createTask ? console.createTask("lazy()") : null
        };
        ctor._ioInfo = ioInfo;
        lazyType._debugInfo = [{ awaited: ioInfo }];
        return lazyType;
      };
      exports.memo = function(type, compare) {
        null == type && console.error(
          "memo: The first argument must be a component. Instead received: %s",
          null === type ? "null" : typeof type
        );
        compare = {
          $$typeof: REACT_MEMO_TYPE,
          type,
          compare: void 0 === compare ? null : compare
        };
        var ownName;
        Object.defineProperty(compare, "displayName", {
          enumerable: false,
          configurable: true,
          get: function() {
            return ownName;
          },
          set: function(name) {
            ownName = name;
            type.name || type.displayName || (Object.defineProperty(type, "name", { value: name }), type.displayName = name);
          }
        });
        return compare;
      };
      exports.startTransition = function(scope) {
        var prevTransition = ReactSharedInternals.T, currentTransition = {};
        currentTransition._updatedFibers = /* @__PURE__ */ new Set();
        ReactSharedInternals.T = currentTransition;
        try {
          var returnValue = scope(), onStartTransitionFinish = ReactSharedInternals.S;
          null !== onStartTransitionFinish && onStartTransitionFinish(currentTransition, returnValue);
          "object" === typeof returnValue && null !== returnValue && "function" === typeof returnValue.then && (ReactSharedInternals.asyncTransitions++, returnValue.then(releaseAsyncTransition, releaseAsyncTransition), returnValue.then(noop, reportGlobalError));
        } catch (error) {
          reportGlobalError(error);
        } finally {
          null === prevTransition && currentTransition._updatedFibers && (scope = currentTransition._updatedFibers.size, currentTransition._updatedFibers.clear(), 10 < scope && console.warn(
            "Detected a large number of updates inside startTransition. If this is due to a subscription please re-write it to use React provided hooks. Otherwise concurrent mode guarantees are off the table."
          )), null !== prevTransition && null !== currentTransition.types && (null !== prevTransition.types && prevTransition.types !== currentTransition.types && console.error(
            "We expected inner Transitions to have transferred the outer types set and that you cannot add to the outer Transition while inside the inner.This is a bug in React."
          ), prevTransition.types = currentTransition.types), ReactSharedInternals.T = prevTransition;
        }
      };
      exports.unstable_useCacheRefresh = function() {
        return resolveDispatcher().useCacheRefresh();
      };
      exports.use = function(usable2) {
        return resolveDispatcher().use(usable2);
      };
      exports.useActionState = function(action, initialState, permalink) {
        return resolveDispatcher().useActionState(
          action,
          initialState,
          permalink
        );
      };
      exports.useCallback = function(callback, deps) {
        return resolveDispatcher().useCallback(callback, deps);
      };
      exports.useContext = function(Context) {
        var dispatcher = resolveDispatcher();
        Context.$$typeof === REACT_CONSUMER_TYPE && console.error(
          "Calling useContext(Context.Consumer) is not supported and will cause bugs. Did you mean to call useContext(Context) instead?"
        );
        return dispatcher.useContext(Context);
      };
      exports.useDebugValue = function(value, formatterFn) {
        return resolveDispatcher().useDebugValue(value, formatterFn);
      };
      exports.useDeferredValue = function(value, initialValue) {
        return resolveDispatcher().useDeferredValue(value, initialValue);
      };
      exports.useEffect = function(create, deps) {
        null == create && console.warn(
          "React Hook useEffect requires an effect callback. Did you forget to pass a callback to the hook?"
        );
        return resolveDispatcher().useEffect(create, deps);
      };
      exports.useEffectEvent = function(callback) {
        return resolveDispatcher().useEffectEvent(callback);
      };
      exports.useId = function() {
        return resolveDispatcher().useId();
      };
      exports.useImperativeHandle = function(ref, create, deps) {
        return resolveDispatcher().useImperativeHandle(ref, create, deps);
      };
      exports.useInsertionEffect = function(create, deps) {
        null == create && console.warn(
          "React Hook useInsertionEffect requires an effect callback. Did you forget to pass a callback to the hook?"
        );
        return resolveDispatcher().useInsertionEffect(create, deps);
      };
      exports.useLayoutEffect = function(create, deps) {
        null == create && console.warn(
          "React Hook useLayoutEffect requires an effect callback. Did you forget to pass a callback to the hook?"
        );
        return resolveDispatcher().useLayoutEffect(create, deps);
      };
      exports.useMemo = function(create, deps) {
        return resolveDispatcher().useMemo(create, deps);
      };
      exports.useOptimistic = function(passthrough, reducer) {
        return resolveDispatcher().useOptimistic(passthrough, reducer);
      };
      exports.useReducer = function(reducer, initialArg, init) {
        return resolveDispatcher().useReducer(reducer, initialArg, init);
      };
      exports.useRef = function(initialValue) {
        return resolveDispatcher().useRef(initialValue);
      };
      exports.useState = function(initialState) {
        return resolveDispatcher().useState(initialState);
      };
      exports.useSyncExternalStore = function(subscribe, getSnapshot, getServerSnapshot) {
        return resolveDispatcher().useSyncExternalStore(
          subscribe,
          getSnapshot,
          getServerSnapshot
        );
      };
      exports.useTransition = function() {
        return resolveDispatcher().useTransition();
      };
      exports.version = "19.2.0";
      "undefined" !== typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ && "function" === typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.registerInternalModuleStop && __REACT_DEVTOOLS_GLOBAL_HOOK__.registerInternalModuleStop(Error());
    })();
  }
});

// node_modules/react/index.js
var require_react = __commonJS({
  "node_modules/react/index.js"(exports, module) {
    "use strict";
    if (false) {
      module.exports = null;
    } else {
      module.exports = require_react_development();
    }
  }
});

// node_modules/doublearray/doublearray.js
var require_doublearray = __commonJS({
  "node_modules/doublearray/doublearray.js"(exports, module) {
    (function() {
      "use strict";
      var TERM_CHAR = "\0", TERM_CODE = 0, ROOT_ID = 0, NOT_FOUND = -1, BASE_SIGNED = true, CHECK_SIGNED = true, BASE_BYTES = 4, CHECK_BYTES = 4, MEMORY_EXPAND_RATIO = 2;
      var newBC = function(initial_size) {
        if (initial_size == null) {
          initial_size = 1024;
        }
        var initBase = function(_base, start, end) {
          for (var i = start; i < end; i++) {
            _base[i] = -i + 1;
          }
          if (0 < check2.array[check2.array.length - 1]) {
            var last_used_id = check2.array.length - 2;
            while (0 < check2.array[last_used_id]) {
              last_used_id--;
            }
            _base[start] = -last_used_id;
          }
        };
        var initCheck = function(_check, start, end) {
          for (var i = start; i < end; i++) {
            _check[i] = -i - 1;
          }
        };
        var realloc = function(min_size) {
          var new_size = min_size * MEMORY_EXPAND_RATIO;
          var base_new_array = newArrayBuffer(base.signed, base.bytes, new_size);
          initBase(base_new_array, base.array.length, new_size);
          base_new_array.set(base.array);
          base.array = null;
          base.array = base_new_array;
          var check_new_array = newArrayBuffer(check2.signed, check2.bytes, new_size);
          initCheck(check_new_array, check2.array.length, new_size);
          check_new_array.set(check2.array);
          check2.array = null;
          check2.array = check_new_array;
        };
        var first_unused_node = ROOT_ID + 1;
        var base = {
          signed: BASE_SIGNED,
          bytes: BASE_BYTES,
          array: newArrayBuffer(BASE_SIGNED, BASE_BYTES, initial_size)
        };
        var check2 = {
          signed: CHECK_SIGNED,
          bytes: CHECK_BYTES,
          array: newArrayBuffer(CHECK_SIGNED, CHECK_BYTES, initial_size)
        };
        base.array[ROOT_ID] = 1;
        check2.array[ROOT_ID] = ROOT_ID;
        initBase(base.array, ROOT_ID + 1, base.array.length);
        initCheck(check2.array, ROOT_ID + 1, check2.array.length);
        return {
          getBaseBuffer: function() {
            return base.array;
          },
          getCheckBuffer: function() {
            return check2.array;
          },
          loadBaseBuffer: function(base_buffer) {
            base.array = base_buffer;
            return this;
          },
          loadCheckBuffer: function(check_buffer) {
            check2.array = check_buffer;
            return this;
          },
          size: function() {
            return Math.max(base.array.length, check2.array.length);
          },
          getBase: function(index) {
            if (base.array.length - 1 < index) {
              return -index + 1;
            }
            return base.array[index];
          },
          getCheck: function(index) {
            if (check2.array.length - 1 < index) {
              return -index - 1;
            }
            return check2.array[index];
          },
          setBase: function(index, base_value) {
            if (base.array.length - 1 < index) {
              realloc(index);
            }
            base.array[index] = base_value;
          },
          setCheck: function(index, check_value) {
            if (check2.array.length - 1 < index) {
              realloc(index);
            }
            check2.array[index] = check_value;
          },
          setFirstUnusedNode: function(index) {
            first_unused_node = index;
          },
          getFirstUnusedNode: function() {
            return first_unused_node;
          },
          shrink: function() {
            var last_index = this.size() - 1;
            while (true) {
              if (0 <= check2.array[last_index]) {
                break;
              }
              last_index--;
            }
            base.array = base.array.subarray(0, last_index + 2);
            check2.array = check2.array.subarray(0, last_index + 2);
          },
          calc: function() {
            var unused_count = 0;
            var size = check2.array.length;
            for (var i = 0; i < size; i++) {
              if (check2.array[i] < 0) {
                unused_count++;
              }
            }
            return {
              all: size,
              unused: unused_count,
              efficiency: (size - unused_count) / size
            };
          },
          dump: function() {
            var dump_base = "";
            var dump_check = "";
            var i;
            for (i = 0; i < base.array.length; i++) {
              dump_base = dump_base + " " + this.getBase(i);
            }
            for (i = 0; i < check2.array.length; i++) {
              dump_check = dump_check + " " + this.getCheck(i);
            }
            console.log("base:" + dump_base);
            console.log("chck:" + dump_check);
            return "base:" + dump_base + " chck:" + dump_check;
          }
        };
      };
      function DoubleArrayBuilder(initial_size) {
        this.bc = newBC(initial_size);
        this.keys = [];
      }
      DoubleArrayBuilder.prototype.append = function(key, record) {
        this.keys.push({ k: key, v: record });
        return this;
      };
      DoubleArrayBuilder.prototype.build = function(keys, sorted) {
        if (keys == null) {
          keys = this.keys;
        }
        if (keys == null) {
          return new DoubleArray(this.bc);
        }
        if (sorted == null) {
          sorted = false;
        }
        var buff_keys = keys.map(function(k) {
          return {
            k: stringToUtf8Bytes(k.k + TERM_CHAR),
            v: k.v
          };
        });
        if (sorted) {
          this.keys = buff_keys;
        } else {
          this.keys = buff_keys.sort(function(k1, k2) {
            var b1 = k1.k;
            var b2 = k2.k;
            var min_length = Math.min(b1.length, b2.length);
            for (var pos = 0; pos < min_length; pos++) {
              if (b1[pos] === b2[pos]) {
                continue;
              }
              return b1[pos] - b2[pos];
            }
            return b1.length - b2.length;
          });
        }
        buff_keys = null;
        this._build(ROOT_ID, 0, 0, this.keys.length);
        return new DoubleArray(this.bc);
      };
      DoubleArrayBuilder.prototype._build = function(parent_index, position, start, length) {
        var children_info = this.getChildrenInfo(position, start, length);
        var _base = this.findAllocatableBase(children_info);
        this.setBC(parent_index, children_info, _base);
        for (var i = 0; i < children_info.length; i = i + 3) {
          var child_code = children_info[i];
          if (child_code === TERM_CODE) {
            continue;
          }
          var child_start = children_info[i + 1];
          var child_len = children_info[i + 2];
          var child_index = _base + child_code;
          this._build(child_index, position + 1, child_start, child_len);
        }
      };
      DoubleArrayBuilder.prototype.getChildrenInfo = function(position, start, length) {
        var current_char = this.keys[start].k[position];
        var i = 0;
        var children_info = new Int32Array(length * 3);
        children_info[i++] = current_char;
        children_info[i++] = start;
        var next_pos = start;
        var start_pos = start;
        for (; next_pos < start + length; next_pos++) {
          var next_char = this.keys[next_pos].k[position];
          if (current_char !== next_char) {
            children_info[i++] = next_pos - start_pos;
            children_info[i++] = next_char;
            children_info[i++] = next_pos;
            current_char = next_char;
            start_pos = next_pos;
          }
        }
        children_info[i++] = next_pos - start_pos;
        children_info = children_info.subarray(0, i);
        return children_info;
      };
      DoubleArrayBuilder.prototype.setBC = function(parent_id, children_info, _base) {
        var bc = this.bc;
        bc.setBase(parent_id, _base);
        var i;
        for (i = 0; i < children_info.length; i = i + 3) {
          var code = children_info[i];
          var child_id = _base + code;
          var prev_unused_id = -bc.getBase(child_id);
          var next_unused_id = -bc.getCheck(child_id);
          if (child_id !== bc.getFirstUnusedNode()) {
            bc.setCheck(prev_unused_id, -next_unused_id);
          } else {
            bc.setFirstUnusedNode(next_unused_id);
          }
          bc.setBase(next_unused_id, -prev_unused_id);
          var check2 = parent_id;
          bc.setCheck(child_id, check2);
          if (code === TERM_CODE) {
            var start_pos = children_info[i + 1];
            var value = this.keys[start_pos].v;
            if (value == null) {
              value = 0;
            }
            var base = -value - 1;
            bc.setBase(child_id, base);
          }
        }
      };
      DoubleArrayBuilder.prototype.findAllocatableBase = function(children_info) {
        var bc = this.bc;
        var _base;
        var curr = bc.getFirstUnusedNode();
        while (true) {
          _base = curr - children_info[0];
          if (_base < 0) {
            curr = -bc.getCheck(curr);
            continue;
          }
          var empty_area_found = true;
          for (var i = 0; i < children_info.length; i = i + 3) {
            var code = children_info[i];
            var candidate_id = _base + code;
            if (!this.isUnusedNode(candidate_id)) {
              curr = -bc.getCheck(curr);
              empty_area_found = false;
              break;
            }
          }
          if (empty_area_found) {
            return _base;
          }
        }
      };
      DoubleArrayBuilder.prototype.isUnusedNode = function(index) {
        var bc = this.bc;
        var check2 = bc.getCheck(index);
        if (index === ROOT_ID) {
          return false;
        }
        if (check2 < 0) {
          return true;
        }
        return false;
      };
      function DoubleArray(bc) {
        this.bc = bc;
        this.bc.shrink();
      }
      DoubleArray.prototype.contain = function(key) {
        var bc = this.bc;
        key += TERM_CHAR;
        var buffer = stringToUtf8Bytes(key);
        var parent = ROOT_ID;
        var child = NOT_FOUND;
        for (var i = 0; i < buffer.length; i++) {
          var code = buffer[i];
          child = this.traverse(parent, code);
          if (child === NOT_FOUND) {
            return false;
          }
          if (bc.getBase(child) <= 0) {
            return true;
          } else {
            parent = child;
            continue;
          }
        }
        return false;
      };
      DoubleArray.prototype.lookup = function(key) {
        key += TERM_CHAR;
        var buffer = stringToUtf8Bytes(key);
        var parent = ROOT_ID;
        var child = NOT_FOUND;
        for (var i = 0; i < buffer.length; i++) {
          var code = buffer[i];
          child = this.traverse(parent, code);
          if (child === NOT_FOUND) {
            return NOT_FOUND;
          }
          parent = child;
        }
        var base = this.bc.getBase(child);
        if (base <= 0) {
          return -base - 1;
        } else {
          return NOT_FOUND;
        }
      };
      DoubleArray.prototype.commonPrefixSearch = function(key) {
        var buffer = stringToUtf8Bytes(key);
        var parent = ROOT_ID;
        var child = NOT_FOUND;
        var result = [];
        for (var i = 0; i < buffer.length; i++) {
          var code = buffer[i];
          child = this.traverse(parent, code);
          if (child !== NOT_FOUND) {
            parent = child;
            var grand_child = this.traverse(child, TERM_CODE);
            if (grand_child !== NOT_FOUND) {
              var base = this.bc.getBase(grand_child);
              var r = {};
              if (base <= 0) {
                r.v = -base - 1;
              }
              r.k = utf8BytesToString(arrayCopy(buffer, 0, i + 1));
              result.push(r);
            }
            continue;
          } else {
            break;
          }
        }
        return result;
      };
      DoubleArray.prototype.traverse = function(parent, code) {
        var child = this.bc.getBase(parent) + code;
        if (this.bc.getCheck(child) === parent) {
          return child;
        } else {
          return NOT_FOUND;
        }
      };
      DoubleArray.prototype.size = function() {
        return this.bc.size();
      };
      DoubleArray.prototype.calc = function() {
        return this.bc.calc();
      };
      DoubleArray.prototype.dump = function() {
        return this.bc.dump();
      };
      var newArrayBuffer = function(signed, bytes, size) {
        if (signed) {
          switch (bytes) {
            case 1:
              return new Int8Array(size);
            case 2:
              return new Int16Array(size);
            case 4:
              return new Int32Array(size);
            default:
              throw new RangeError("Invalid newArray parameter element_bytes:" + bytes);
          }
        } else {
          switch (bytes) {
            case 1:
              return new Uint8Array(size);
            case 2:
              return new Uint16Array(size);
            case 4:
              return new Uint32Array(size);
            default:
              throw new RangeError("Invalid newArray parameter element_bytes:" + bytes);
          }
        }
      };
      var arrayCopy = function(src, src_offset, length) {
        var buffer = new ArrayBuffer(length);
        var dstU8 = new Uint8Array(buffer, 0, length);
        var srcU8 = src.subarray(src_offset, length);
        dstU8.set(srcU8);
        return dstU8;
      };
      var stringToUtf8Bytes = function(str) {
        var bytes = new Uint8Array(new ArrayBuffer(str.length * 4));
        var i = 0, j = 0;
        while (i < str.length) {
          var unicode_code;
          var utf16_code = str.charCodeAt(i++);
          if (utf16_code >= 55296 && utf16_code <= 56319) {
            var upper = utf16_code;
            var lower = str.charCodeAt(i++);
            if (lower >= 56320 && lower <= 57343) {
              unicode_code = (upper - 55296) * (1 << 10) + (1 << 16) + (lower - 56320);
            } else {
              return null;
            }
          } else {
            unicode_code = utf16_code;
          }
          if (unicode_code < 128) {
            bytes[j++] = unicode_code;
          } else if (unicode_code < 1 << 11) {
            bytes[j++] = unicode_code >>> 6 | 192;
            bytes[j++] = unicode_code & 63 | 128;
          } else if (unicode_code < 1 << 16) {
            bytes[j++] = unicode_code >>> 12 | 224;
            bytes[j++] = unicode_code >> 6 & 63 | 128;
            bytes[j++] = unicode_code & 63 | 128;
          } else if (unicode_code < 1 << 21) {
            bytes[j++] = unicode_code >>> 18 | 240;
            bytes[j++] = unicode_code >> 12 & 63 | 128;
            bytes[j++] = unicode_code >> 6 & 63 | 128;
            bytes[j++] = unicode_code & 63 | 128;
          } else {
          }
        }
        return bytes.subarray(0, j);
      };
      var utf8BytesToString = function(bytes) {
        var str = "";
        var code, b1, b2, b3, b4, upper, lower;
        var i = 0;
        while (i < bytes.length) {
          b1 = bytes[i++];
          if (b1 < 128) {
            code = b1;
          } else if (b1 >> 5 === 6) {
            b2 = bytes[i++];
            code = (b1 & 31) << 6 | b2 & 63;
          } else if (b1 >> 4 === 14) {
            b2 = bytes[i++];
            b3 = bytes[i++];
            code = (b1 & 15) << 12 | (b2 & 63) << 6 | b3 & 63;
          } else {
            b2 = bytes[i++];
            b3 = bytes[i++];
            b4 = bytes[i++];
            code = (b1 & 7) << 18 | (b2 & 63) << 12 | (b3 & 63) << 6 | b4 & 63;
          }
          if (code < 65536) {
            str += String.fromCharCode(code);
          } else {
            code -= 65536;
            upper = 55296 | code >> 10;
            lower = 56320 | code & 1023;
            str += String.fromCharCode(upper, lower);
          }
        }
        return str;
      };
      var doublearray = {
        builder: function(initial_size) {
          return new DoubleArrayBuilder(initial_size);
        },
        load: function(base_buffer, check_buffer) {
          var bc = newBC(0);
          bc.loadBaseBuffer(base_buffer);
          bc.loadCheckBuffer(check_buffer);
          return new DoubleArray(bc);
        }
      };
      if ("undefined" === typeof module) {
        window.doublearray = doublearray;
      } else {
        module.exports = doublearray;
      }
    })();
  }
});

// node_modules/kuromoji/src/util/ByteBuffer.js
var require_ByteBuffer = __commonJS({
  "node_modules/kuromoji/src/util/ByteBuffer.js"(exports, module) {
    "use strict";
    var stringToUtf8Bytes = function(str) {
      var bytes = new Uint8Array(str.length * 4);
      var i = 0, j = 0;
      while (i < str.length) {
        var unicode_code;
        var utf16_code = str.charCodeAt(i++);
        if (utf16_code >= 55296 && utf16_code <= 56319) {
          var upper = utf16_code;
          var lower = str.charCodeAt(i++);
          if (lower >= 56320 && lower <= 57343) {
            unicode_code = (upper - 55296) * (1 << 10) + (1 << 16) + (lower - 56320);
          } else {
            return null;
          }
        } else {
          unicode_code = utf16_code;
        }
        if (unicode_code < 128) {
          bytes[j++] = unicode_code;
        } else if (unicode_code < 1 << 11) {
          bytes[j++] = unicode_code >>> 6 | 192;
          bytes[j++] = unicode_code & 63 | 128;
        } else if (unicode_code < 1 << 16) {
          bytes[j++] = unicode_code >>> 12 | 224;
          bytes[j++] = unicode_code >> 6 & 63 | 128;
          bytes[j++] = unicode_code & 63 | 128;
        } else if (unicode_code < 1 << 21) {
          bytes[j++] = unicode_code >>> 18 | 240;
          bytes[j++] = unicode_code >> 12 & 63 | 128;
          bytes[j++] = unicode_code >> 6 & 63 | 128;
          bytes[j++] = unicode_code & 63 | 128;
        } else {
        }
      }
      return bytes.subarray(0, j);
    };
    var utf8BytesToString = function(bytes) {
      var str = "";
      var code, b1, b2, b3, b4, upper, lower;
      var i = 0;
      while (i < bytes.length) {
        b1 = bytes[i++];
        if (b1 < 128) {
          code = b1;
        } else if (b1 >> 5 === 6) {
          b2 = bytes[i++];
          code = (b1 & 31) << 6 | b2 & 63;
        } else if (b1 >> 4 === 14) {
          b2 = bytes[i++];
          b3 = bytes[i++];
          code = (b1 & 15) << 12 | (b2 & 63) << 6 | b3 & 63;
        } else {
          b2 = bytes[i++];
          b3 = bytes[i++];
          b4 = bytes[i++];
          code = (b1 & 7) << 18 | (b2 & 63) << 12 | (b3 & 63) << 6 | b4 & 63;
        }
        if (code < 65536) {
          str += String.fromCharCode(code);
        } else {
          code -= 65536;
          upper = 55296 | code >> 10;
          lower = 56320 | code & 1023;
          str += String.fromCharCode(upper, lower);
        }
      }
      return str;
    };
    function ByteBuffer(arg) {
      var initial_size;
      if (arg == null) {
        initial_size = 1024 * 1024;
      } else if (typeof arg === "number") {
        initial_size = arg;
      } else if (arg instanceof Uint8Array) {
        this.buffer = arg;
        this.position = 0;
        return;
      } else {
        throw typeof arg + " is invalid parameter type for ByteBuffer constructor";
      }
      this.buffer = new Uint8Array(initial_size);
      this.position = 0;
    }
    ByteBuffer.prototype.size = function() {
      return this.buffer.length;
    };
    ByteBuffer.prototype.reallocate = function() {
      var new_array = new Uint8Array(this.buffer.length * 2);
      new_array.set(this.buffer);
      this.buffer = new_array;
    };
    ByteBuffer.prototype.shrink = function() {
      this.buffer = this.buffer.subarray(0, this.position);
      return this.buffer;
    };
    ByteBuffer.prototype.put = function(b) {
      if (this.buffer.length < this.position + 1) {
        this.reallocate();
      }
      this.buffer[this.position++] = b;
    };
    ByteBuffer.prototype.get = function(index) {
      if (index == null) {
        index = this.position;
        this.position += 1;
      }
      if (this.buffer.length < index + 1) {
        return 0;
      }
      return this.buffer[index];
    };
    ByteBuffer.prototype.putShort = function(num) {
      if (65535 < num) {
        throw num + " is over short value";
      }
      var lower = 255 & num;
      var upper = (65280 & num) >> 8;
      this.put(lower);
      this.put(upper);
    };
    ByteBuffer.prototype.getShort = function(index) {
      if (index == null) {
        index = this.position;
        this.position += 2;
      }
      if (this.buffer.length < index + 2) {
        return 0;
      }
      var lower = this.buffer[index];
      var upper = this.buffer[index + 1];
      var value = (upper << 8) + lower;
      if (value & 32768) {
        value = -(value - 1 ^ 65535);
      }
      return value;
    };
    ByteBuffer.prototype.putInt = function(num) {
      if (4294967295 < num) {
        throw num + " is over integer value";
      }
      var b0 = 255 & num;
      var b1 = (65280 & num) >> 8;
      var b2 = (16711680 & num) >> 16;
      var b3 = (4278190080 & num) >> 24;
      this.put(b0);
      this.put(b1);
      this.put(b2);
      this.put(b3);
    };
    ByteBuffer.prototype.getInt = function(index) {
      if (index == null) {
        index = this.position;
        this.position += 4;
      }
      if (this.buffer.length < index + 4) {
        return 0;
      }
      var b0 = this.buffer[index];
      var b1 = this.buffer[index + 1];
      var b2 = this.buffer[index + 2];
      var b3 = this.buffer[index + 3];
      return (b3 << 24) + (b2 << 16) + (b1 << 8) + b0;
    };
    ByteBuffer.prototype.readInt = function() {
      var pos = this.position;
      this.position += 4;
      return this.getInt(pos);
    };
    ByteBuffer.prototype.putString = function(str) {
      var bytes = stringToUtf8Bytes(str);
      for (var i = 0; i < bytes.length; i++) {
        this.put(bytes[i]);
      }
      this.put(0);
    };
    ByteBuffer.prototype.getString = function(index) {
      var buf = [], ch;
      if (index == null) {
        index = this.position;
      }
      while (true) {
        if (this.buffer.length < index + 1) {
          break;
        }
        ch = this.get(index++);
        if (ch === 0) {
          break;
        } else {
          buf.push(ch);
        }
      }
      this.position = index;
      return utf8BytesToString(buf);
    };
    module.exports = ByteBuffer;
  }
});

// node_modules/kuromoji/src/dict/TokenInfoDictionary.js
var require_TokenInfoDictionary = __commonJS({
  "node_modules/kuromoji/src/dict/TokenInfoDictionary.js"(exports, module) {
    "use strict";
    var ByteBuffer = require_ByteBuffer();
    function TokenInfoDictionary() {
      this.dictionary = new ByteBuffer(10 * 1024 * 1024);
      this.target_map = {};
      this.pos_buffer = new ByteBuffer(10 * 1024 * 1024);
    }
    TokenInfoDictionary.prototype.buildDictionary = function(entries) {
      var dictionary_entries = {};
      for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        if (entry.length < 4) {
          continue;
        }
        var surface_form = entry[0];
        var left_id = entry[1];
        var right_id = entry[2];
        var word_cost = entry[3];
        var feature = entry.slice(4).join(",");
        if (!isFinite(left_id) || !isFinite(right_id) || !isFinite(word_cost)) {
          console.log(entry);
        }
        var token_info_id = this.put(left_id, right_id, word_cost, surface_form, feature);
        dictionary_entries[token_info_id] = surface_form;
      }
      this.dictionary.shrink();
      this.pos_buffer.shrink();
      return dictionary_entries;
    };
    TokenInfoDictionary.prototype.put = function(left_id, right_id, word_cost, surface_form, feature) {
      var token_info_id = this.dictionary.position;
      var pos_id = this.pos_buffer.position;
      this.dictionary.putShort(left_id);
      this.dictionary.putShort(right_id);
      this.dictionary.putShort(word_cost);
      this.dictionary.putInt(pos_id);
      this.pos_buffer.putString(surface_form + "," + feature);
      return token_info_id;
    };
    TokenInfoDictionary.prototype.addMapping = function(source, target) {
      var mapping = this.target_map[source];
      if (mapping == null) {
        mapping = [];
      }
      mapping.push(target);
      this.target_map[source] = mapping;
    };
    TokenInfoDictionary.prototype.targetMapToBuffer = function() {
      var buffer = new ByteBuffer();
      var map_keys_size = Object.keys(this.target_map).length;
      buffer.putInt(map_keys_size);
      for (var key in this.target_map) {
        var values = this.target_map[key];
        var map_values_size = values.length;
        buffer.putInt(parseInt(key));
        buffer.putInt(map_values_size);
        for (var i = 0; i < values.length; i++) {
          buffer.putInt(values[i]);
        }
      }
      return buffer.shrink();
    };
    TokenInfoDictionary.prototype.loadDictionary = function(array_buffer) {
      this.dictionary = new ByteBuffer(array_buffer);
      return this;
    };
    TokenInfoDictionary.prototype.loadPosVector = function(array_buffer) {
      this.pos_buffer = new ByteBuffer(array_buffer);
      return this;
    };
    TokenInfoDictionary.prototype.loadTargetMap = function(array_buffer) {
      var buffer = new ByteBuffer(array_buffer);
      buffer.position = 0;
      this.target_map = {};
      buffer.readInt();
      while (true) {
        if (buffer.buffer.length < buffer.position + 1) {
          break;
        }
        var key = buffer.readInt();
        var map_values_size = buffer.readInt();
        for (var i = 0; i < map_values_size; i++) {
          var value = buffer.readInt();
          this.addMapping(key, value);
        }
      }
      return this;
    };
    TokenInfoDictionary.prototype.getFeatures = function(token_info_id_str) {
      var token_info_id = parseInt(token_info_id_str);
      if (isNaN(token_info_id)) {
        return "";
      }
      var pos_id = this.dictionary.getInt(token_info_id + 6);
      return this.pos_buffer.getString(pos_id);
    };
    module.exports = TokenInfoDictionary;
  }
});

// node_modules/kuromoji/src/dict/ConnectionCosts.js
var require_ConnectionCosts = __commonJS({
  "node_modules/kuromoji/src/dict/ConnectionCosts.js"(exports, module) {
    "use strict";
    function ConnectionCosts(forward_dimension, backward_dimension) {
      this.forward_dimension = forward_dimension;
      this.backward_dimension = backward_dimension;
      this.buffer = new Int16Array(forward_dimension * backward_dimension + 2);
      this.buffer[0] = forward_dimension;
      this.buffer[1] = backward_dimension;
    }
    ConnectionCosts.prototype.put = function(forward_id, backward_id, cost) {
      var index = forward_id * this.backward_dimension + backward_id + 2;
      if (this.buffer.length < index + 1) {
        throw "ConnectionCosts buffer overflow";
      }
      this.buffer[index] = cost;
    };
    ConnectionCosts.prototype.get = function(forward_id, backward_id) {
      var index = forward_id * this.backward_dimension + backward_id + 2;
      if (this.buffer.length < index + 1) {
        throw "ConnectionCosts buffer overflow";
      }
      return this.buffer[index];
    };
    ConnectionCosts.prototype.loadConnectionCosts = function(connection_costs_buffer) {
      this.forward_dimension = connection_costs_buffer[0];
      this.backward_dimension = connection_costs_buffer[1];
      this.buffer = connection_costs_buffer;
    };
    module.exports = ConnectionCosts;
  }
});

// node_modules/kuromoji/src/dict/CharacterClass.js
var require_CharacterClass = __commonJS({
  "node_modules/kuromoji/src/dict/CharacterClass.js"(exports, module) {
    "use strict";
    function CharacterClass(class_id, class_name, is_always_invoke, is_grouping, max_length) {
      this.class_id = class_id;
      this.class_name = class_name;
      this.is_always_invoke = is_always_invoke;
      this.is_grouping = is_grouping;
      this.max_length = max_length;
    }
    module.exports = CharacterClass;
  }
});

// node_modules/kuromoji/src/dict/InvokeDefinitionMap.js
var require_InvokeDefinitionMap = __commonJS({
  "node_modules/kuromoji/src/dict/InvokeDefinitionMap.js"(exports, module) {
    "use strict";
    var ByteBuffer = require_ByteBuffer();
    var CharacterClass = require_CharacterClass();
    function InvokeDefinitionMap() {
      this.map = [];
      this.lookup_table = {};
    }
    InvokeDefinitionMap.load = function(invoke_def_buffer) {
      var invoke_def = new InvokeDefinitionMap();
      var character_category_definition = [];
      var buffer = new ByteBuffer(invoke_def_buffer);
      while (buffer.position + 1 < buffer.size()) {
        var class_id = character_category_definition.length;
        var is_always_invoke = buffer.get();
        var is_grouping = buffer.get();
        var max_length = buffer.getInt();
        var class_name = buffer.getString();
        character_category_definition.push(new CharacterClass(class_id, class_name, is_always_invoke, is_grouping, max_length));
      }
      invoke_def.init(character_category_definition);
      return invoke_def;
    };
    InvokeDefinitionMap.prototype.init = function(character_category_definition) {
      if (character_category_definition == null) {
        return;
      }
      for (var i = 0; i < character_category_definition.length; i++) {
        var character_class = character_category_definition[i];
        this.map[i] = character_class;
        this.lookup_table[character_class.class_name] = i;
      }
    };
    InvokeDefinitionMap.prototype.getCharacterClass = function(class_id) {
      return this.map[class_id];
    };
    InvokeDefinitionMap.prototype.lookup = function(class_name) {
      var class_id = this.lookup_table[class_name];
      if (class_id == null) {
        return null;
      }
      return class_id;
    };
    InvokeDefinitionMap.prototype.toBuffer = function() {
      var buffer = new ByteBuffer();
      for (var i = 0; i < this.map.length; i++) {
        var char_class = this.map[i];
        buffer.put(char_class.is_always_invoke);
        buffer.put(char_class.is_grouping);
        buffer.putInt(char_class.max_length);
        buffer.putString(char_class.class_name);
      }
      buffer.shrink();
      return buffer.buffer;
    };
    module.exports = InvokeDefinitionMap;
  }
});

// node_modules/kuromoji/src/util/SurrogateAwareString.js
var require_SurrogateAwareString = __commonJS({
  "node_modules/kuromoji/src/util/SurrogateAwareString.js"(exports, module) {
    "use strict";
    function SurrogateAwareString(str) {
      this.str = str;
      this.index_mapping = [];
      for (var pos = 0; pos < str.length; pos++) {
        var ch = str.charAt(pos);
        this.index_mapping.push(pos);
        if (SurrogateAwareString.isSurrogatePair(ch)) {
          pos++;
        }
      }
      this.length = this.index_mapping.length;
    }
    SurrogateAwareString.prototype.slice = function(index) {
      if (this.index_mapping.length <= index) {
        return "";
      }
      var surrogate_aware_index = this.index_mapping[index];
      return this.str.slice(surrogate_aware_index);
    };
    SurrogateAwareString.prototype.charAt = function(index) {
      if (this.str.length <= index) {
        return "";
      }
      var surrogate_aware_start_index = this.index_mapping[index];
      var surrogate_aware_end_index = this.index_mapping[index + 1];
      if (surrogate_aware_end_index == null) {
        return this.str.slice(surrogate_aware_start_index);
      }
      return this.str.slice(surrogate_aware_start_index, surrogate_aware_end_index);
    };
    SurrogateAwareString.prototype.charCodeAt = function(index) {
      if (this.index_mapping.length <= index) {
        return NaN;
      }
      var surrogate_aware_index = this.index_mapping[index];
      var upper = this.str.charCodeAt(surrogate_aware_index);
      var lower;
      if (upper >= 55296 && upper <= 56319 && surrogate_aware_index < this.str.length) {
        lower = this.str.charCodeAt(surrogate_aware_index + 1);
        if (lower >= 56320 && lower <= 57343) {
          return (upper - 55296) * 1024 + lower - 56320 + 65536;
        }
      }
      return upper;
    };
    SurrogateAwareString.prototype.toString = function() {
      return this.str;
    };
    SurrogateAwareString.isSurrogatePair = function(ch) {
      var utf16_code = ch.charCodeAt(0);
      if (utf16_code >= 55296 && utf16_code <= 56319) {
        return true;
      } else {
        return false;
      }
    };
    module.exports = SurrogateAwareString;
  }
});

// node_modules/kuromoji/src/dict/CharacterDefinition.js
var require_CharacterDefinition = __commonJS({
  "node_modules/kuromoji/src/dict/CharacterDefinition.js"(exports, module) {
    "use strict";
    var InvokeDefinitionMap = require_InvokeDefinitionMap();
    var CharacterClass = require_CharacterClass();
    var SurrogateAwareString = require_SurrogateAwareString();
    var DEFAULT_CATEGORY = "DEFAULT";
    function CharacterDefinition() {
      this.character_category_map = new Uint8Array(65536);
      this.compatible_category_map = new Uint32Array(65536);
      this.invoke_definition_map = null;
    }
    CharacterDefinition.load = function(cat_map_buffer, compat_cat_map_buffer, invoke_def_buffer) {
      var char_def = new CharacterDefinition();
      char_def.character_category_map = cat_map_buffer;
      char_def.compatible_category_map = compat_cat_map_buffer;
      char_def.invoke_definition_map = InvokeDefinitionMap.load(invoke_def_buffer);
      return char_def;
    };
    CharacterDefinition.parseCharCategory = function(class_id, parsed_category_def) {
      var category = parsed_category_def[1];
      var invoke2 = parseInt(parsed_category_def[2]);
      var grouping = parseInt(parsed_category_def[3]);
      var max_length = parseInt(parsed_category_def[4]);
      if (!isFinite(invoke2) || invoke2 !== 0 && invoke2 !== 1) {
        console.log("char.def parse error. INVOKE is 0 or 1 in:" + invoke2);
        return null;
      }
      if (!isFinite(grouping) || grouping !== 0 && grouping !== 1) {
        console.log("char.def parse error. GROUP is 0 or 1 in:" + grouping);
        return null;
      }
      if (!isFinite(max_length) || max_length < 0) {
        console.log("char.def parse error. LENGTH is 1 to n:" + max_length);
        return null;
      }
      var is_invoke = invoke2 === 1;
      var is_grouping = grouping === 1;
      return new CharacterClass(class_id, category, is_invoke, is_grouping, max_length);
    };
    CharacterDefinition.parseCategoryMapping = function(parsed_category_mapping) {
      var start = parseInt(parsed_category_mapping[1]);
      var default_category = parsed_category_mapping[2];
      var compatible_category = 3 < parsed_category_mapping.length ? parsed_category_mapping.slice(3) : [];
      if (!isFinite(start) || start < 0 || start > 65535) {
        console.log("char.def parse error. CODE is invalid:" + start);
      }
      return { start, default: default_category, compatible: compatible_category };
    };
    CharacterDefinition.parseRangeCategoryMapping = function(parsed_category_mapping) {
      var start = parseInt(parsed_category_mapping[1]);
      var end = parseInt(parsed_category_mapping[2]);
      var default_category = parsed_category_mapping[3];
      var compatible_category = 4 < parsed_category_mapping.length ? parsed_category_mapping.slice(4) : [];
      if (!isFinite(start) || start < 0 || start > 65535) {
        console.log("char.def parse error. CODE is invalid:" + start);
      }
      if (!isFinite(end) || end < 0 || end > 65535) {
        console.log("char.def parse error. CODE is invalid:" + end);
      }
      return { start, end, default: default_category, compatible: compatible_category };
    };
    CharacterDefinition.prototype.initCategoryMappings = function(category_mapping) {
      var code_point;
      if (category_mapping != null) {
        for (var i = 0; i < category_mapping.length; i++) {
          var mapping = category_mapping[i];
          var end = mapping.end || mapping.start;
          for (code_point = mapping.start; code_point <= end; code_point++) {
            this.character_category_map[code_point] = this.invoke_definition_map.lookup(mapping.default);
            for (var j = 0; j < mapping.compatible.length; j++) {
              var bitset = this.compatible_category_map[code_point];
              var compatible_category = mapping.compatible[j];
              if (compatible_category == null) {
                continue;
              }
              var class_id = this.invoke_definition_map.lookup(compatible_category);
              if (class_id == null) {
                continue;
              }
              var class_id_bit = 1 << class_id;
              bitset = bitset | class_id_bit;
              this.compatible_category_map[code_point] = bitset;
            }
          }
        }
      }
      var default_id = this.invoke_definition_map.lookup(DEFAULT_CATEGORY);
      if (default_id == null) {
        return;
      }
      for (code_point = 0; code_point < this.character_category_map.length; code_point++) {
        if (this.character_category_map[code_point] === 0) {
          this.character_category_map[code_point] = 1 << default_id;
        }
      }
    };
    CharacterDefinition.prototype.lookupCompatibleCategory = function(ch) {
      var classes = [];
      var code = ch.charCodeAt(0);
      var integer;
      if (code < this.compatible_category_map.length) {
        integer = this.compatible_category_map[code];
      }
      if (integer == null || integer === 0) {
        return classes;
      }
      for (var bit = 0; bit < 32; bit++) {
        if (integer << 31 - bit >>> 31 === 1) {
          var character_class = this.invoke_definition_map.getCharacterClass(bit);
          if (character_class == null) {
            continue;
          }
          classes.push(character_class);
        }
      }
      return classes;
    };
    CharacterDefinition.prototype.lookup = function(ch) {
      var class_id;
      var code = ch.charCodeAt(0);
      if (SurrogateAwareString.isSurrogatePair(ch)) {
        class_id = this.invoke_definition_map.lookup(DEFAULT_CATEGORY);
      } else if (code < this.character_category_map.length) {
        class_id = this.character_category_map[code];
      }
      if (class_id == null) {
        class_id = this.invoke_definition_map.lookup(DEFAULT_CATEGORY);
      }
      return this.invoke_definition_map.getCharacterClass(class_id);
    };
    module.exports = CharacterDefinition;
  }
});

// node_modules/kuromoji/src/dict/UnknownDictionary.js
var require_UnknownDictionary = __commonJS({
  "node_modules/kuromoji/src/dict/UnknownDictionary.js"(exports, module) {
    "use strict";
    var TokenInfoDictionary = require_TokenInfoDictionary();
    var CharacterDefinition = require_CharacterDefinition();
    var ByteBuffer = require_ByteBuffer();
    function UnknownDictionary() {
      this.dictionary = new ByteBuffer(10 * 1024 * 1024);
      this.target_map = {};
      this.pos_buffer = new ByteBuffer(10 * 1024 * 1024);
      this.character_definition = null;
    }
    UnknownDictionary.prototype = Object.create(TokenInfoDictionary.prototype);
    UnknownDictionary.prototype.characterDefinition = function(character_definition) {
      this.character_definition = character_definition;
      return this;
    };
    UnknownDictionary.prototype.lookup = function(ch) {
      return this.character_definition.lookup(ch);
    };
    UnknownDictionary.prototype.lookupCompatibleCategory = function(ch) {
      return this.character_definition.lookupCompatibleCategory(ch);
    };
    UnknownDictionary.prototype.loadUnknownDictionaries = function(unk_buffer, unk_pos_buffer, unk_map_buffer, cat_map_buffer, compat_cat_map_buffer, invoke_def_buffer) {
      this.loadDictionary(unk_buffer);
      this.loadPosVector(unk_pos_buffer);
      this.loadTargetMap(unk_map_buffer);
      this.character_definition = CharacterDefinition.load(cat_map_buffer, compat_cat_map_buffer, invoke_def_buffer);
    };
    module.exports = UnknownDictionary;
  }
});

// node_modules/kuromoji/src/dict/DynamicDictionaries.js
var require_DynamicDictionaries = __commonJS({
  "node_modules/kuromoji/src/dict/DynamicDictionaries.js"(exports, module) {
    "use strict";
    var doublearray = require_doublearray();
    var TokenInfoDictionary = require_TokenInfoDictionary();
    var ConnectionCosts = require_ConnectionCosts();
    var UnknownDictionary = require_UnknownDictionary();
    function DynamicDictionaries2(trie, token_info_dictionary, connection_costs, unknown_dictionary) {
      if (trie != null) {
        this.trie = trie;
      } else {
        this.trie = doublearray.builder(0).build([
          { k: "", v: 1 }
        ]);
      }
      if (token_info_dictionary != null) {
        this.token_info_dictionary = token_info_dictionary;
      } else {
        this.token_info_dictionary = new TokenInfoDictionary();
      }
      if (connection_costs != null) {
        this.connection_costs = connection_costs;
      } else {
        this.connection_costs = new ConnectionCosts(0, 0);
      }
      if (unknown_dictionary != null) {
        this.unknown_dictionary = unknown_dictionary;
      } else {
        this.unknown_dictionary = new UnknownDictionary();
      }
    }
    DynamicDictionaries2.prototype.loadTrie = function(base_buffer, check_buffer) {
      this.trie = doublearray.load(base_buffer, check_buffer);
      return this;
    };
    DynamicDictionaries2.prototype.loadTokenInfoDictionaries = function(token_info_buffer, pos_buffer, target_map_buffer) {
      this.token_info_dictionary.loadDictionary(token_info_buffer);
      this.token_info_dictionary.loadPosVector(pos_buffer);
      this.token_info_dictionary.loadTargetMap(target_map_buffer);
      return this;
    };
    DynamicDictionaries2.prototype.loadConnectionCosts = function(cc_buffer) {
      this.connection_costs.loadConnectionCosts(cc_buffer);
      return this;
    };
    DynamicDictionaries2.prototype.loadUnknownDictionaries = function(unk_buffer, unk_pos_buffer, unk_map_buffer, cat_map_buffer, compat_cat_map_buffer, invoke_def_buffer) {
      this.unknown_dictionary.loadUnknownDictionaries(unk_buffer, unk_pos_buffer, unk_map_buffer, cat_map_buffer, compat_cat_map_buffer, invoke_def_buffer);
      return this;
    };
    module.exports = DynamicDictionaries2;
  }
});

// node_modules/kuromoji/src/viterbi/ViterbiNode.js
var require_ViterbiNode = __commonJS({
  "node_modules/kuromoji/src/viterbi/ViterbiNode.js"(exports, module) {
    "use strict";
    function ViterbiNode(node_name, node_cost, start_pos, length, type, left_id, right_id, surface_form) {
      this.name = node_name;
      this.cost = node_cost;
      this.start_pos = start_pos;
      this.length = length;
      this.left_id = left_id;
      this.right_id = right_id;
      this.prev = null;
      this.surface_form = surface_form;
      if (type === "BOS") {
        this.shortest_cost = 0;
      } else {
        this.shortest_cost = Number.MAX_VALUE;
      }
      this.type = type;
    }
    module.exports = ViterbiNode;
  }
});

// node_modules/kuromoji/src/viterbi/ViterbiLattice.js
var require_ViterbiLattice = __commonJS({
  "node_modules/kuromoji/src/viterbi/ViterbiLattice.js"(exports, module) {
    "use strict";
    var ViterbiNode = require_ViterbiNode();
    function ViterbiLattice() {
      this.nodes_end_at = [];
      this.nodes_end_at[0] = [new ViterbiNode(-1, 0, 0, 0, "BOS", 0, 0, "")];
      this.eos_pos = 1;
    }
    ViterbiLattice.prototype.append = function(node) {
      var last_pos = node.start_pos + node.length - 1;
      if (this.eos_pos < last_pos) {
        this.eos_pos = last_pos;
      }
      var prev_nodes = this.nodes_end_at[last_pos];
      if (prev_nodes == null) {
        prev_nodes = [];
      }
      prev_nodes.push(node);
      this.nodes_end_at[last_pos] = prev_nodes;
    };
    ViterbiLattice.prototype.appendEos = function() {
      var last_index = this.nodes_end_at.length;
      this.eos_pos++;
      this.nodes_end_at[last_index] = [new ViterbiNode(-1, 0, this.eos_pos, 0, "EOS", 0, 0, "")];
    };
    module.exports = ViterbiLattice;
  }
});

// node_modules/kuromoji/src/viterbi/ViterbiBuilder.js
var require_ViterbiBuilder = __commonJS({
  "node_modules/kuromoji/src/viterbi/ViterbiBuilder.js"(exports, module) {
    "use strict";
    var ViterbiNode = require_ViterbiNode();
    var ViterbiLattice = require_ViterbiLattice();
    var SurrogateAwareString = require_SurrogateAwareString();
    function ViterbiBuilder(dic) {
      this.trie = dic.trie;
      this.token_info_dictionary = dic.token_info_dictionary;
      this.unknown_dictionary = dic.unknown_dictionary;
    }
    ViterbiBuilder.prototype.build = function(sentence_str) {
      var lattice = new ViterbiLattice();
      var sentence = new SurrogateAwareString(sentence_str);
      var key, trie_id, left_id, right_id, word_cost;
      for (var pos = 0; pos < sentence.length; pos++) {
        var tail = sentence.slice(pos);
        var vocabulary = this.trie.commonPrefixSearch(tail);
        for (var n = 0; n < vocabulary.length; n++) {
          trie_id = vocabulary[n].v;
          key = vocabulary[n].k;
          var token_info_ids = this.token_info_dictionary.target_map[trie_id];
          for (var i = 0; i < token_info_ids.length; i++) {
            var token_info_id = parseInt(token_info_ids[i]);
            left_id = this.token_info_dictionary.dictionary.getShort(token_info_id);
            right_id = this.token_info_dictionary.dictionary.getShort(token_info_id + 2);
            word_cost = this.token_info_dictionary.dictionary.getShort(token_info_id + 4);
            lattice.append(new ViterbiNode(token_info_id, word_cost, pos + 1, key.length, "KNOWN", left_id, right_id, key));
          }
        }
        var surrogate_aware_tail = new SurrogateAwareString(tail);
        var head_char = new SurrogateAwareString(surrogate_aware_tail.charAt(0));
        var head_char_class = this.unknown_dictionary.lookup(head_char.toString());
        if (vocabulary == null || vocabulary.length === 0 || head_char_class.is_always_invoke === 1) {
          key = head_char;
          if (head_char_class.is_grouping === 1 && 1 < surrogate_aware_tail.length) {
            for (var k = 1; k < surrogate_aware_tail.length; k++) {
              var next_char = surrogate_aware_tail.charAt(k);
              var next_char_class = this.unknown_dictionary.lookup(next_char);
              if (head_char_class.class_name !== next_char_class.class_name) {
                break;
              }
              key += next_char;
            }
          }
          var unk_ids = this.unknown_dictionary.target_map[head_char_class.class_id];
          for (var j = 0; j < unk_ids.length; j++) {
            var unk_id = parseInt(unk_ids[j]);
            left_id = this.unknown_dictionary.dictionary.getShort(unk_id);
            right_id = this.unknown_dictionary.dictionary.getShort(unk_id + 2);
            word_cost = this.unknown_dictionary.dictionary.getShort(unk_id + 4);
            lattice.append(new ViterbiNode(unk_id, word_cost, pos + 1, key.length, "UNKNOWN", left_id, right_id, key.toString()));
          }
        }
      }
      lattice.appendEos();
      return lattice;
    };
    module.exports = ViterbiBuilder;
  }
});

// node_modules/kuromoji/src/viterbi/ViterbiSearcher.js
var require_ViterbiSearcher = __commonJS({
  "node_modules/kuromoji/src/viterbi/ViterbiSearcher.js"(exports, module) {
    "use strict";
    function ViterbiSearcher(connection_costs) {
      this.connection_costs = connection_costs;
    }
    ViterbiSearcher.prototype.search = function(lattice) {
      lattice = this.forward(lattice);
      return this.backward(lattice);
    };
    ViterbiSearcher.prototype.forward = function(lattice) {
      var i, j, k;
      for (i = 1; i <= lattice.eos_pos; i++) {
        var nodes = lattice.nodes_end_at[i];
        if (nodes == null) {
          continue;
        }
        for (j = 0; j < nodes.length; j++) {
          var node = nodes[j];
          var cost = Number.MAX_VALUE;
          var shortest_prev_node;
          var prev_nodes = lattice.nodes_end_at[node.start_pos - 1];
          if (prev_nodes == null) {
            continue;
          }
          for (k = 0; k < prev_nodes.length; k++) {
            var prev_node = prev_nodes[k];
            var edge_cost;
            if (node.left_id == null || prev_node.right_id == null) {
              console.log("Left or right is null");
              edge_cost = 0;
            } else {
              edge_cost = this.connection_costs.get(prev_node.right_id, node.left_id);
            }
            var _cost = prev_node.shortest_cost + edge_cost + node.cost;
            if (_cost < cost) {
              shortest_prev_node = prev_node;
              cost = _cost;
            }
          }
          node.prev = shortest_prev_node;
          node.shortest_cost = cost;
        }
      }
      return lattice;
    };
    ViterbiSearcher.prototype.backward = function(lattice) {
      var shortest_path = [];
      var eos = lattice.nodes_end_at[lattice.nodes_end_at.length - 1][0];
      var node_back = eos.prev;
      if (node_back == null) {
        return [];
      }
      while (node_back.type !== "BOS") {
        shortest_path.push(node_back);
        if (node_back.prev == null) {
          return [];
        }
        node_back = node_back.prev;
      }
      return shortest_path.reverse();
    };
    module.exports = ViterbiSearcher;
  }
});

// node_modules/kuromoji/src/util/IpadicFormatter.js
var require_IpadicFormatter = __commonJS({
  "node_modules/kuromoji/src/util/IpadicFormatter.js"(exports, module) {
    "use strict";
    function IpadicFormatter() {
    }
    IpadicFormatter.prototype.formatEntry = function(word_id, position, type, features) {
      var token = {};
      token.word_id = word_id;
      token.word_type = type;
      token.word_position = position;
      token.surface_form = features[0];
      token.pos = features[1];
      token.pos_detail_1 = features[2];
      token.pos_detail_2 = features[3];
      token.pos_detail_3 = features[4];
      token.conjugated_type = features[5];
      token.conjugated_form = features[6];
      token.basic_form = features[7];
      token.reading = features[8];
      token.pronunciation = features[9];
      return token;
    };
    IpadicFormatter.prototype.formatUnknownEntry = function(word_id, position, type, features, surface_form) {
      var token = {};
      token.word_id = word_id;
      token.word_type = type;
      token.word_position = position;
      token.surface_form = surface_form;
      token.pos = features[1];
      token.pos_detail_1 = features[2];
      token.pos_detail_2 = features[3];
      token.pos_detail_3 = features[4];
      token.conjugated_type = features[5];
      token.conjugated_form = features[6];
      token.basic_form = features[7];
      return token;
    };
    module.exports = IpadicFormatter;
  }
});

// node_modules/kuromoji/src/Tokenizer.js
var require_Tokenizer = __commonJS({
  "node_modules/kuromoji/src/Tokenizer.js"(exports, module) {
    "use strict";
    var ViterbiBuilder = require_ViterbiBuilder();
    var ViterbiSearcher = require_ViterbiSearcher();
    var IpadicFormatter = require_IpadicFormatter();
    var PUNCTUATION = /、|。/;
    function Tokenizer2(dic) {
      this.token_info_dictionary = dic.token_info_dictionary;
      this.unknown_dictionary = dic.unknown_dictionary;
      this.viterbi_builder = new ViterbiBuilder(dic);
      this.viterbi_searcher = new ViterbiSearcher(dic.connection_costs);
      this.formatter = new IpadicFormatter();
    }
    Tokenizer2.splitByPunctuation = function(input) {
      var sentences = [];
      var tail = input;
      while (true) {
        if (tail === "") {
          break;
        }
        var index = tail.search(PUNCTUATION);
        if (index < 0) {
          sentences.push(tail);
          break;
        }
        sentences.push(tail.substring(0, index + 1));
        tail = tail.substring(index + 1);
      }
      return sentences;
    };
    Tokenizer2.prototype.tokenize = function(text) {
      var sentences = Tokenizer2.splitByPunctuation(text);
      var tokens = [];
      for (var i = 0; i < sentences.length; i++) {
        var sentence = sentences[i];
        this.tokenizeForSentence(sentence, tokens);
      }
      return tokens;
    };
    Tokenizer2.prototype.tokenizeForSentence = function(sentence, tokens) {
      if (tokens == null) {
        tokens = [];
      }
      var lattice = this.getLattice(sentence);
      var best_path = this.viterbi_searcher.search(lattice);
      var last_pos = 0;
      if (tokens.length > 0) {
        last_pos = tokens[tokens.length - 1].word_position;
      }
      for (var j = 0; j < best_path.length; j++) {
        var node = best_path[j];
        var token, features, features_line;
        if (node.type === "KNOWN") {
          features_line = this.token_info_dictionary.getFeatures(node.name);
          if (features_line == null) {
            features = [];
          } else {
            features = features_line.split(",");
          }
          token = this.formatter.formatEntry(node.name, last_pos + node.start_pos, node.type, features);
        } else if (node.type === "UNKNOWN") {
          features_line = this.unknown_dictionary.getFeatures(node.name);
          if (features_line == null) {
            features = [];
          } else {
            features = features_line.split(",");
          }
          token = this.formatter.formatUnknownEntry(node.name, last_pos + node.start_pos, node.type, features, node.surface_form);
        } else {
          token = this.formatter.formatEntry(node.name, last_pos + node.start_pos, node.type, []);
        }
        tokens.push(token);
      }
      return tokens;
    };
    Tokenizer2.prototype.getLattice = function(text) {
      return this.viterbi_builder.build(text);
    };
    module.exports = Tokenizer2;
  }
});

// node_modules/react/cjs/react-jsx-runtime.development.js
var require_react_jsx_runtime_development = __commonJS({
  "node_modules/react/cjs/react-jsx-runtime.development.js"(exports) {
    "use strict";
    (function() {
      function getComponentNameFromType(type) {
        if (null == type) return null;
        if ("function" === typeof type)
          return type.$$typeof === REACT_CLIENT_REFERENCE ? null : type.displayName || type.name || null;
        if ("string" === typeof type) return type;
        switch (type) {
          case REACT_FRAGMENT_TYPE:
            return "Fragment";
          case REACT_PROFILER_TYPE:
            return "Profiler";
          case REACT_STRICT_MODE_TYPE:
            return "StrictMode";
          case REACT_SUSPENSE_TYPE:
            return "Suspense";
          case REACT_SUSPENSE_LIST_TYPE:
            return "SuspenseList";
          case REACT_ACTIVITY_TYPE:
            return "Activity";
        }
        if ("object" === typeof type)
          switch ("number" === typeof type.tag && console.error(
            "Received an unexpected object in getComponentNameFromType(). This is likely a bug in React. Please file an issue."
          ), type.$$typeof) {
            case REACT_PORTAL_TYPE:
              return "Portal";
            case REACT_CONTEXT_TYPE:
              return type.displayName || "Context";
            case REACT_CONSUMER_TYPE:
              return (type._context.displayName || "Context") + ".Consumer";
            case REACT_FORWARD_REF_TYPE:
              var innerType = type.render;
              type = type.displayName;
              type || (type = innerType.displayName || innerType.name || "", type = "" !== type ? "ForwardRef(" + type + ")" : "ForwardRef");
              return type;
            case REACT_MEMO_TYPE:
              return innerType = type.displayName || null, null !== innerType ? innerType : getComponentNameFromType(type.type) || "Memo";
            case REACT_LAZY_TYPE:
              innerType = type._payload;
              type = type._init;
              try {
                return getComponentNameFromType(type(innerType));
              } catch (x) {
              }
          }
        return null;
      }
      function testStringCoercion(value) {
        return "" + value;
      }
      function checkKeyStringCoercion(value) {
        try {
          testStringCoercion(value);
          var JSCompiler_inline_result = false;
        } catch (e) {
          JSCompiler_inline_result = true;
        }
        if (JSCompiler_inline_result) {
          JSCompiler_inline_result = console;
          var JSCompiler_temp_const = JSCompiler_inline_result.error;
          var JSCompiler_inline_result$jscomp$0 = "function" === typeof Symbol && Symbol.toStringTag && value[Symbol.toStringTag] || value.constructor.name || "Object";
          JSCompiler_temp_const.call(
            JSCompiler_inline_result,
            "The provided key is an unsupported type %s. This value must be coerced to a string before using it here.",
            JSCompiler_inline_result$jscomp$0
          );
          return testStringCoercion(value);
        }
      }
      function getTaskName(type) {
        if (type === REACT_FRAGMENT_TYPE) return "<>";
        if ("object" === typeof type && null !== type && type.$$typeof === REACT_LAZY_TYPE)
          return "<...>";
        try {
          var name = getComponentNameFromType(type);
          return name ? "<" + name + ">" : "<...>";
        } catch (x) {
          return "<...>";
        }
      }
      function getOwner() {
        var dispatcher = ReactSharedInternals.A;
        return null === dispatcher ? null : dispatcher.getOwner();
      }
      function UnknownOwner() {
        return Error("react-stack-top-frame");
      }
      function hasValidKey(config) {
        if (hasOwnProperty.call(config, "key")) {
          var getter = Object.getOwnPropertyDescriptor(config, "key").get;
          if (getter && getter.isReactWarning) return false;
        }
        return void 0 !== config.key;
      }
      function defineKeyPropWarningGetter(props, displayName) {
        function warnAboutAccessingKey() {
          specialPropKeyWarningShown || (specialPropKeyWarningShown = true, console.error(
            "%s: `key` is not a prop. Trying to access it will result in `undefined` being returned. If you need to access the same value within the child component, you should pass it as a different prop. (https://react.dev/link/special-props)",
            displayName
          ));
        }
        warnAboutAccessingKey.isReactWarning = true;
        Object.defineProperty(props, "key", {
          get: warnAboutAccessingKey,
          configurable: true
        });
      }
      function elementRefGetterWithDeprecationWarning() {
        var componentName = getComponentNameFromType(this.type);
        didWarnAboutElementRef[componentName] || (didWarnAboutElementRef[componentName] = true, console.error(
          "Accessing element.ref was removed in React 19. ref is now a regular prop. It will be removed from the JSX Element type in a future release."
        ));
        componentName = this.props.ref;
        return void 0 !== componentName ? componentName : null;
      }
      function ReactElement(type, key, props, owner, debugStack, debugTask) {
        var refProp = props.ref;
        type = {
          $$typeof: REACT_ELEMENT_TYPE,
          type,
          key,
          props,
          _owner: owner
        };
        null !== (void 0 !== refProp ? refProp : null) ? Object.defineProperty(type, "ref", {
          enumerable: false,
          get: elementRefGetterWithDeprecationWarning
        }) : Object.defineProperty(type, "ref", { enumerable: false, value: null });
        type._store = {};
        Object.defineProperty(type._store, "validated", {
          configurable: false,
          enumerable: false,
          writable: true,
          value: 0
        });
        Object.defineProperty(type, "_debugInfo", {
          configurable: false,
          enumerable: false,
          writable: true,
          value: null
        });
        Object.defineProperty(type, "_debugStack", {
          configurable: false,
          enumerable: false,
          writable: true,
          value: debugStack
        });
        Object.defineProperty(type, "_debugTask", {
          configurable: false,
          enumerable: false,
          writable: true,
          value: debugTask
        });
        Object.freeze && (Object.freeze(type.props), Object.freeze(type));
        return type;
      }
      function jsxDEVImpl(type, config, maybeKey, isStaticChildren, debugStack, debugTask) {
        var children = config.children;
        if (void 0 !== children)
          if (isStaticChildren)
            if (isArrayImpl(children)) {
              for (isStaticChildren = 0; isStaticChildren < children.length; isStaticChildren++)
                validateChildKeys(children[isStaticChildren]);
              Object.freeze && Object.freeze(children);
            } else
              console.error(
                "React.jsx: Static children should always be an array. You are likely explicitly calling React.jsxs or React.jsxDEV. Use the Babel transform instead."
              );
          else validateChildKeys(children);
        if (hasOwnProperty.call(config, "key")) {
          children = getComponentNameFromType(type);
          var keys = Object.keys(config).filter(function(k) {
            return "key" !== k;
          });
          isStaticChildren = 0 < keys.length ? "{key: someKey, " + keys.join(": ..., ") + ": ...}" : "{key: someKey}";
          didWarnAboutKeySpread[children + isStaticChildren] || (keys = 0 < keys.length ? "{" + keys.join(": ..., ") + ": ...}" : "{}", console.error(
            'A props object containing a "key" prop is being spread into JSX:\n  let props = %s;\n  <%s {...props} />\nReact keys must be passed directly to JSX without using spread:\n  let props = %s;\n  <%s key={someKey} {...props} />',
            isStaticChildren,
            children,
            keys,
            children
          ), didWarnAboutKeySpread[children + isStaticChildren] = true);
        }
        children = null;
        void 0 !== maybeKey && (checkKeyStringCoercion(maybeKey), children = "" + maybeKey);
        hasValidKey(config) && (checkKeyStringCoercion(config.key), children = "" + config.key);
        if ("key" in config) {
          maybeKey = {};
          for (var propName in config)
            "key" !== propName && (maybeKey[propName] = config[propName]);
        } else maybeKey = config;
        children && defineKeyPropWarningGetter(
          maybeKey,
          "function" === typeof type ? type.displayName || type.name || "Unknown" : type
        );
        return ReactElement(
          type,
          children,
          maybeKey,
          getOwner(),
          debugStack,
          debugTask
        );
      }
      function validateChildKeys(node) {
        isValidElement(node) ? node._store && (node._store.validated = 1) : "object" === typeof node && null !== node && node.$$typeof === REACT_LAZY_TYPE && ("fulfilled" === node._payload.status ? isValidElement(node._payload.value) && node._payload.value._store && (node._payload.value._store.validated = 1) : node._store && (node._store.validated = 1));
      }
      function isValidElement(object) {
        return "object" === typeof object && null !== object && object.$$typeof === REACT_ELEMENT_TYPE;
      }
      var React3 = require_react(), REACT_ELEMENT_TYPE = Symbol.for("react.transitional.element"), REACT_PORTAL_TYPE = Symbol.for("react.portal"), REACT_FRAGMENT_TYPE = Symbol.for("react.fragment"), REACT_STRICT_MODE_TYPE = Symbol.for("react.strict_mode"), REACT_PROFILER_TYPE = Symbol.for("react.profiler"), REACT_CONSUMER_TYPE = Symbol.for("react.consumer"), REACT_CONTEXT_TYPE = Symbol.for("react.context"), REACT_FORWARD_REF_TYPE = Symbol.for("react.forward_ref"), REACT_SUSPENSE_TYPE = Symbol.for("react.suspense"), REACT_SUSPENSE_LIST_TYPE = Symbol.for("react.suspense_list"), REACT_MEMO_TYPE = Symbol.for("react.memo"), REACT_LAZY_TYPE = Symbol.for("react.lazy"), REACT_ACTIVITY_TYPE = Symbol.for("react.activity"), REACT_CLIENT_REFERENCE = Symbol.for("react.client.reference"), ReactSharedInternals = React3.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE, hasOwnProperty = Object.prototype.hasOwnProperty, isArrayImpl = Array.isArray, createTask = console.createTask ? console.createTask : function() {
        return null;
      };
      React3 = {
        react_stack_bottom_frame: function(callStackForError) {
          return callStackForError();
        }
      };
      var specialPropKeyWarningShown;
      var didWarnAboutElementRef = {};
      var unknownOwnerDebugStack = React3.react_stack_bottom_frame.bind(
        React3,
        UnknownOwner
      )();
      var unknownOwnerDebugTask = createTask(getTaskName(UnknownOwner));
      var didWarnAboutKeySpread = {};
      exports.Fragment = REACT_FRAGMENT_TYPE;
      exports.jsx = function(type, config, maybeKey) {
        var trackActualOwner = 1e4 > ReactSharedInternals.recentlyCreatedOwnerStacks++;
        return jsxDEVImpl(
          type,
          config,
          maybeKey,
          false,
          trackActualOwner ? Error("react-stack-top-frame") : unknownOwnerDebugStack,
          trackActualOwner ? createTask(getTaskName(type)) : unknownOwnerDebugTask
        );
      };
      exports.jsxs = function(type, config, maybeKey) {
        var trackActualOwner = 1e4 > ReactSharedInternals.recentlyCreatedOwnerStacks++;
        return jsxDEVImpl(
          type,
          config,
          maybeKey,
          true,
          trackActualOwner ? Error("react-stack-top-frame") : unknownOwnerDebugStack,
          trackActualOwner ? createTask(getTaskName(type)) : unknownOwnerDebugTask
        );
      };
    })();
  }
});

// node_modules/react/jsx-runtime.js
var require_jsx_runtime = __commonJS({
  "node_modules/react/jsx-runtime.js"(exports, module) {
    "use strict";
    if (false) {
      module.exports = null;
    } else {
      module.exports = require_react_jsx_runtime_development();
    }
  }
});

// node_modules/@tauri-apps/api/external/tslib/tslib.es6.js
function __classPrivateFieldGet(receiver, state2, kind2, f) {
  if (kind2 === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
  if (typeof state2 === "function" ? receiver !== state2 || !f : !state2.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
  return kind2 === "m" ? f : kind2 === "a" ? f.call(receiver) : f ? f.value : state2.get(receiver);
}
function __classPrivateFieldSet(receiver, state2, value, kind2, f) {
  if (kind2 === "m") throw new TypeError("Private method is not writable");
  if (kind2 === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
  if (typeof state2 === "function" ? receiver !== state2 || !f : !state2.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
  return kind2 === "a" ? f.call(receiver, value) : f ? f.value = value : state2.set(receiver, value), value;
}

// node_modules/@tauri-apps/api/core.js
var _Channel_onmessage;
var _Channel_nextMessageIndex;
var _Channel_pendingMessages;
var _Channel_messageEndIndex;
var _Resource_rid;
var SERIALIZE_TO_IPC_FN = "__TAURI_TO_IPC_KEY__";
function transformCallback(callback, once2 = false) {
  return window.__TAURI_INTERNALS__.transformCallback(callback, once2);
}
var Channel = class {
  constructor(onmessage) {
    _Channel_onmessage.set(this, void 0);
    _Channel_nextMessageIndex.set(this, 0);
    _Channel_pendingMessages.set(this, []);
    _Channel_messageEndIndex.set(this, void 0);
    __classPrivateFieldSet(this, _Channel_onmessage, onmessage || (() => {
    }), "f");
    this.id = transformCallback((rawMessage) => {
      const index = rawMessage.index;
      if ("end" in rawMessage) {
        if (index == __classPrivateFieldGet(this, _Channel_nextMessageIndex, "f")) {
          this.cleanupCallback();
        } else {
          __classPrivateFieldSet(this, _Channel_messageEndIndex, index, "f");
        }
        return;
      }
      const message = rawMessage.message;
      if (index == __classPrivateFieldGet(this, _Channel_nextMessageIndex, "f")) {
        __classPrivateFieldGet(this, _Channel_onmessage, "f").call(this, message);
        __classPrivateFieldSet(this, _Channel_nextMessageIndex, __classPrivateFieldGet(this, _Channel_nextMessageIndex, "f") + 1, "f");
        while (__classPrivateFieldGet(this, _Channel_nextMessageIndex, "f") in __classPrivateFieldGet(this, _Channel_pendingMessages, "f")) {
          const message2 = __classPrivateFieldGet(this, _Channel_pendingMessages, "f")[__classPrivateFieldGet(this, _Channel_nextMessageIndex, "f")];
          __classPrivateFieldGet(this, _Channel_onmessage, "f").call(this, message2);
          delete __classPrivateFieldGet(this, _Channel_pendingMessages, "f")[__classPrivateFieldGet(this, _Channel_nextMessageIndex, "f")];
          __classPrivateFieldSet(this, _Channel_nextMessageIndex, __classPrivateFieldGet(this, _Channel_nextMessageIndex, "f") + 1, "f");
        }
        if (__classPrivateFieldGet(this, _Channel_nextMessageIndex, "f") === __classPrivateFieldGet(this, _Channel_messageEndIndex, "f")) {
          this.cleanupCallback();
        }
      } else {
        __classPrivateFieldGet(this, _Channel_pendingMessages, "f")[index] = message;
      }
    });
  }
  cleanupCallback() {
    window.__TAURI_INTERNALS__.unregisterCallback(this.id);
  }
  set onmessage(handler) {
    __classPrivateFieldSet(this, _Channel_onmessage, handler, "f");
  }
  get onmessage() {
    return __classPrivateFieldGet(this, _Channel_onmessage, "f");
  }
  [(_Channel_onmessage = /* @__PURE__ */ new WeakMap(), _Channel_nextMessageIndex = /* @__PURE__ */ new WeakMap(), _Channel_pendingMessages = /* @__PURE__ */ new WeakMap(), _Channel_messageEndIndex = /* @__PURE__ */ new WeakMap(), SERIALIZE_TO_IPC_FN)]() {
    return `__CHANNEL__:${this.id}`;
  }
  toJSON() {
    return this[SERIALIZE_TO_IPC_FN]();
  }
};
async function invoke(cmd, args = {}, options) {
  return window.__TAURI_INTERNALS__.invoke(cmd, args, options);
}
_Resource_rid = /* @__PURE__ */ new WeakMap();

// node_modules/@tauri-apps/plugin-http/dist-js/index.js
var ERROR_REQUEST_CANCELLED = "Request cancelled";
async function fetch(input, init) {
  const signal = init?.signal;
  if (signal?.aborted) {
    throw new Error(ERROR_REQUEST_CANCELLED);
  }
  const maxRedirections = init?.maxRedirections;
  const connectTimeout = init?.connectTimeout;
  const proxy = init?.proxy;
  const danger = init?.danger;
  if (init) {
    delete init.maxRedirections;
    delete init.connectTimeout;
    delete init.proxy;
    delete init.danger;
  }
  const headers = init?.headers ? init.headers instanceof Headers ? init.headers : new Headers(init.headers) : new Headers();
  const req = new Request(input, init);
  const buffer = await req.arrayBuffer();
  const data = buffer.byteLength !== 0 ? Array.from(new Uint8Array(buffer)) : null;
  for (const [key, value] of req.headers) {
    if (!headers.get(key)) {
      headers.set(key, value);
    }
  }
  const headersArray = headers instanceof Headers ? Array.from(headers.entries()) : Array.isArray(headers) ? headers : Object.entries(headers);
  const mappedHeaders = headersArray.map(([name, val]) => [
    name,
    // we need to ensure we have all header values as strings
    // eslint-disable-next-line
    typeof val === "string" ? val : val.toString()
  ]);
  if (signal?.aborted) {
    throw new Error(ERROR_REQUEST_CANCELLED);
  }
  const rid = await invoke("plugin:http|fetch", {
    clientConfig: {
      method: req.method,
      url: req.url,
      headers: mappedHeaders,
      data,
      maxRedirections,
      connectTimeout,
      proxy,
      danger
    }
  });
  const abort = () => invoke("plugin:http|fetch_cancel", { rid }).catch(() => {
  });
  if (signal?.aborted) {
    void abort();
    throw new Error(ERROR_REQUEST_CANCELLED);
  }
  signal?.addEventListener("abort", () => void abort());
  const { status, statusText, url, headers: responseHeaders, rid: responseRid } = await invoke("plugin:http|fetch_send", {
    rid
  });
  let bodyDropped = false;
  const dropBody = () => {
    if (bodyDropped)
      return Promise.resolve();
    bodyDropped = true;
    return invoke("plugin:http|fetch_cancel_body", { rid: responseRid }).catch(() => {
    });
  };
  const readChunk = async (controller) => {
    let data2;
    try {
      data2 = await invoke("plugin:http|fetch_read_body", {
        rid: responseRid
      });
    } catch (e) {
      controller.error(e);
      void dropBody();
      return;
    }
    const dataUint8 = new Uint8Array(data2);
    const lastByte = dataUint8[dataUint8.byteLength - 1];
    const actualData = dataUint8.slice(0, dataUint8.byteLength - 1);
    if (lastByte === 1) {
      controller.close();
      return;
    }
    controller.enqueue(actualData);
  };
  const body = [101, 103, 204, 205, 304].includes(status) ? null : new ReadableStream({
    start: (controller) => {
      signal?.addEventListener("abort", () => {
        controller.error(ERROR_REQUEST_CANCELLED);
        void dropBody();
      });
    },
    pull: (controller) => readChunk(controller),
    cancel: () => {
      void dropBody();
    }
  });
  const res = new Response(body, {
    status,
    statusText
  });
  Object.defineProperty(res, "url", { value: url, writable: false });
  Object.defineProperty(res, "headers", {
    value: new Headers(responseHeaders),
    writable: false
  });
  const originalClone = res.clone.bind(res);
  Object.defineProperty(res, "clone", {
    value: () => {
      const cloned = originalClone();
      Object.defineProperty(cloned, "url", { value: url, writable: false });
      Object.defineProperty(cloned, "headers", {
        value: new Headers(responseHeaders),
        writable: false
      });
      return cloned;
    }
  });
  return res;
}

// utils/i18n.ts
var import_react = __toESM(require_react(), 1);

// utils/platform.ts
var IS_WINDOWS = typeof navigator !== "undefined" && /Windows/.test(navigator.userAgent);

// utils/i18n.ts
var STORAGE_KEY = "linguaclip_lang";
function detectDefaultLang() {
  const nav = typeof navigator !== "undefined" ? navigator.language : "";
  return nav?.toLowerCase().startsWith("zh") ? "zh" : "en";
}
function loadLang() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "en" || stored === "zh") return stored;
  } catch {
  }
  return detectDefaultLang();
}
var currentLang = loadLang();
function getLang() {
  return currentLang;
}

// utils/dictionaryEn.ts
var ENTITY = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
var htmlText = (html) => html.replace(/<(style|rt|rp)\b[\s\S]*?<\/\1>/gi, "").replace(/<[^>]+>/g, "").replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (m, e) => {
  if (e[0] !== "#") return ENTITY[e.toLowerCase()] ?? m;
  const cp = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : +e.slice(1);
  return cp <= 1114111 ? String.fromCodePoint(cp) : m;
}).replace(/\s+/g, " ").trim();
var LANG_NAME = { en: "English", es: "Spanish", fr: "French", de: "German", ja: "Japanese", no: "Norwegian Bokm\xE5l" };
var parseWiktionary = (body, word, lang) => {
  const items = lang === "no" ? Array.isArray(body?.other) ? body.other.filter((x) => x?.language === LANG_NAME.no) : void 0 : body?.[lang];
  if (!Array.isArray(items) || items.length === 0) return null;
  const senses = [];
  const forms = [];
  const anchor = new RegExp(`href="/wiki/([^"#]+)#${LANG_NAME[lang].replace(/ /g, "_")}"`, "g");
  for (const item of items) {
    const pos = htmlText(item.partOfSpeech ?? "");
    for (const d of item.definitions ?? []) {
      const html = d.definition ?? "";
      if (html.includes("Template:rfdef")) continue;
      const text = htmlText(html);
      if (!text) continue;
      if (html.includes("form-of-definition")) {
        const lemma = [...html.matchAll(anchor)].pop()?.[1];
        const name = lemma && decodeURIComponent(lemma).replace(/_/g, " ");
        if (name && name !== word) {
          forms.push({ lemma: name, note: text });
          continue;
        }
      }
      const examples = d.parsedExamples?.length ? d.parsedExamples.map((x) => [[htmlText(x.example ?? ""), htmlText(x.translation ?? "")].filter(Boolean).join("\n")]) : (d.examples ?? []).map((x) => [htmlText(x)]);
      senses.push({ pos, text: [text], examples: examples.filter((x) => x[0]) });
    }
  }
  return { entry: senses.length ? { word, phonetic: "", senses, source: "wiktionary" } : null, forms };
};
var parseJisho = (body, query) => {
  const items = Array.isArray(body?.data) ? body.data : [];
  const exact = items.filter((i) => i.japanese?.some((x) => x.word === query || x.reading === query));
  const found = (exact.length ? exact : items.slice(0, 1)).flatMap((item) => {
    const { word, reading } = item.japanese?.[0] ?? {};
    const head = word || reading;
    if (!head) return [];
    let pos = "";
    const senses = [];
    for (const s of item.senses ?? []) {
      if (s.parts_of_speech?.length) pos = s.parts_of_speech.join(", ");
      if (/wikipedia/i.test(pos)) continue;
      const text = (s.english_definitions ?? []).join("; ");
      if (text) senses.push({ pos, text: [text], examples: [] });
    }
    return senses.length ? [{ word: head, phonetic: reading && reading !== head ? reading : "", senses, source: "jisho", reading: reading || head }] : [];
  });
  return found.length ? found : null;
};

// utils/localDict.ts
var import_react5 = __toESM(require_react(), 1);

// node_modules/@tauri-apps/api/path.js
var BaseDirectory;
(function(BaseDirectory2) {
  BaseDirectory2[BaseDirectory2["Audio"] = 1] = "Audio";
  BaseDirectory2[BaseDirectory2["Cache"] = 2] = "Cache";
  BaseDirectory2[BaseDirectory2["Config"] = 3] = "Config";
  BaseDirectory2[BaseDirectory2["Data"] = 4] = "Data";
  BaseDirectory2[BaseDirectory2["LocalData"] = 5] = "LocalData";
  BaseDirectory2[BaseDirectory2["Document"] = 6] = "Document";
  BaseDirectory2[BaseDirectory2["Download"] = 7] = "Download";
  BaseDirectory2[BaseDirectory2["Picture"] = 8] = "Picture";
  BaseDirectory2[BaseDirectory2["Public"] = 9] = "Public";
  BaseDirectory2[BaseDirectory2["Video"] = 10] = "Video";
  BaseDirectory2[BaseDirectory2["Resource"] = 11] = "Resource";
  BaseDirectory2[BaseDirectory2["Temp"] = 12] = "Temp";
  BaseDirectory2[BaseDirectory2["AppConfig"] = 13] = "AppConfig";
  BaseDirectory2[BaseDirectory2["AppData"] = 14] = "AppData";
  BaseDirectory2[BaseDirectory2["AppLocalData"] = 15] = "AppLocalData";
  BaseDirectory2[BaseDirectory2["AppCache"] = 16] = "AppCache";
  BaseDirectory2[BaseDirectory2["AppLog"] = 17] = "AppLog";
  BaseDirectory2[BaseDirectory2["Desktop"] = 18] = "Desktop";
  BaseDirectory2[BaseDirectory2["Executable"] = 19] = "Executable";
  BaseDirectory2[BaseDirectory2["Font"] = 20] = "Font";
  BaseDirectory2[BaseDirectory2["Home"] = 21] = "Home";
  BaseDirectory2[BaseDirectory2["Runtime"] = 22] = "Runtime";
  BaseDirectory2[BaseDirectory2["Template"] = 23] = "Template";
})(BaseDirectory || (BaseDirectory = {}));

// node_modules/@tauri-apps/api/dpi.js
var LogicalSize = class {
  constructor(...args) {
    this.type = "Logical";
    if (args.length === 1) {
      if ("Logical" in args[0]) {
        this.width = args[0].Logical.width;
        this.height = args[0].Logical.height;
      } else {
        this.width = args[0].width;
        this.height = args[0].height;
      }
    } else {
      this.width = args[0];
      this.height = args[1];
    }
  }
  /**
   * Converts the logical size to a physical one.
   * @example
   * ```typescript
   * import { LogicalSize } from '@tauri-apps/api/dpi';
   * import { getCurrentWindow } from '@tauri-apps/api/window';
   *
   * const appWindow = getCurrentWindow();
   * const factor = await appWindow.scaleFactor();
   * const size = new LogicalSize(400, 500);
   * const physical = size.toPhysical(factor);
   * ```
   *
   * @since 2.0.0
   */
  toPhysical(scaleFactor) {
    return new PhysicalSize(this.width * scaleFactor, this.height * scaleFactor);
  }
  [SERIALIZE_TO_IPC_FN]() {
    return {
      width: this.width,
      height: this.height
    };
  }
  toJSON() {
    return this[SERIALIZE_TO_IPC_FN]();
  }
};
var PhysicalSize = class {
  constructor(...args) {
    this.type = "Physical";
    if (args.length === 1) {
      if ("Physical" in args[0]) {
        this.width = args[0].Physical.width;
        this.height = args[0].Physical.height;
      } else {
        this.width = args[0].width;
        this.height = args[0].height;
      }
    } else {
      this.width = args[0];
      this.height = args[1];
    }
  }
  /**
   * Converts the physical size to a logical one.
   * @example
   * ```typescript
   * import { getCurrentWindow } from '@tauri-apps/api/window';
   * const appWindow = getCurrentWindow();
   * const factor = await appWindow.scaleFactor();
   * const size = await appWindow.innerSize(); // PhysicalSize
   * const logical = size.toLogical(factor);
   * ```
   */
  toLogical(scaleFactor) {
    return new LogicalSize(this.width / scaleFactor, this.height / scaleFactor);
  }
  [SERIALIZE_TO_IPC_FN]() {
    return {
      width: this.width,
      height: this.height
    };
  }
  toJSON() {
    return this[SERIALIZE_TO_IPC_FN]();
  }
};
var Size = class {
  constructor(size) {
    this.size = size;
  }
  toLogical(scaleFactor) {
    return this.size instanceof LogicalSize ? this.size : this.size.toLogical(scaleFactor);
  }
  toPhysical(scaleFactor) {
    return this.size instanceof PhysicalSize ? this.size : this.size.toPhysical(scaleFactor);
  }
  [SERIALIZE_TO_IPC_FN]() {
    return {
      [`${this.size.type}`]: {
        width: this.size.width,
        height: this.size.height
      }
    };
  }
  toJSON() {
    return this[SERIALIZE_TO_IPC_FN]();
  }
};
var LogicalPosition = class {
  constructor(...args) {
    this.type = "Logical";
    if (args.length === 1) {
      if ("Logical" in args[0]) {
        this.x = args[0].Logical.x;
        this.y = args[0].Logical.y;
      } else {
        this.x = args[0].x;
        this.y = args[0].y;
      }
    } else {
      this.x = args[0];
      this.y = args[1];
    }
  }
  /**
   * Converts the logical position to a physical one.
   * @example
   * ```typescript
   * import { LogicalPosition } from '@tauri-apps/api/dpi';
   * import { getCurrentWindow } from '@tauri-apps/api/window';
   *
   * const appWindow = getCurrentWindow();
   * const factor = await appWindow.scaleFactor();
   * const position = new LogicalPosition(400, 500);
   * const physical = position.toPhysical(factor);
   * ```
   *
   * @since 2.0.0
   */
  toPhysical(scaleFactor) {
    return new PhysicalPosition(this.x * scaleFactor, this.y * scaleFactor);
  }
  [SERIALIZE_TO_IPC_FN]() {
    return {
      x: this.x,
      y: this.y
    };
  }
  toJSON() {
    return this[SERIALIZE_TO_IPC_FN]();
  }
};
var PhysicalPosition = class {
  constructor(...args) {
    this.type = "Physical";
    if (args.length === 1) {
      if ("Physical" in args[0]) {
        this.x = args[0].Physical.x;
        this.y = args[0].Physical.y;
      } else {
        this.x = args[0].x;
        this.y = args[0].y;
      }
    } else {
      this.x = args[0];
      this.y = args[1];
    }
  }
  /**
   * Converts the physical position to a logical one.
   * @example
   * ```typescript
   * import { PhysicalPosition } from '@tauri-apps/api/dpi';
   * import { getCurrentWindow } from '@tauri-apps/api/window';
   *
   * const appWindow = getCurrentWindow();
   * const factor = await appWindow.scaleFactor();
   * const position = new PhysicalPosition(400, 500);
   * const physical = position.toLogical(factor);
   * ```
   *
   * @since 2.0.0
   */
  toLogical(scaleFactor) {
    return new LogicalPosition(this.x / scaleFactor, this.y / scaleFactor);
  }
  [SERIALIZE_TO_IPC_FN]() {
    return {
      x: this.x,
      y: this.y
    };
  }
  toJSON() {
    return this[SERIALIZE_TO_IPC_FN]();
  }
};
var Position = class {
  constructor(position) {
    this.position = position;
  }
  toLogical(scaleFactor) {
    return this.position instanceof LogicalPosition ? this.position : this.position.toLogical(scaleFactor);
  }
  toPhysical(scaleFactor) {
    return this.position instanceof PhysicalPosition ? this.position : this.position.toPhysical(scaleFactor);
  }
  [SERIALIZE_TO_IPC_FN]() {
    return {
      [`${this.position.type}`]: {
        x: this.position.x,
        y: this.position.y
      }
    };
  }
  toJSON() {
    return this[SERIALIZE_TO_IPC_FN]();
  }
};

// node_modules/@tauri-apps/api/event.js
var TauriEvent;
(function(TauriEvent2) {
  TauriEvent2["WINDOW_RESIZED"] = "tauri://resize";
  TauriEvent2["WINDOW_MOVED"] = "tauri://move";
  TauriEvent2["WINDOW_CLOSE_REQUESTED"] = "tauri://close-requested";
  TauriEvent2["WINDOW_DESTROYED"] = "tauri://destroyed";
  TauriEvent2["WINDOW_FOCUS"] = "tauri://focus";
  TauriEvent2["WINDOW_BLUR"] = "tauri://blur";
  TauriEvent2["WINDOW_SCALE_FACTOR_CHANGED"] = "tauri://scale-change";
  TauriEvent2["WINDOW_THEME_CHANGED"] = "tauri://theme-changed";
  TauriEvent2["WINDOW_CREATED"] = "tauri://window-created";
  TauriEvent2["WINDOW_SUSPENDED"] = "tauri://suspended";
  TauriEvent2["WINDOW_RESUMED"] = "tauri://resumed";
  TauriEvent2["WEBVIEW_CREATED"] = "tauri://webview-created";
  TauriEvent2["DRAG_ENTER"] = "tauri://drag-enter";
  TauriEvent2["DRAG_OVER"] = "tauri://drag-over";
  TauriEvent2["DRAG_DROP"] = "tauri://drag-drop";
  TauriEvent2["DRAG_LEAVE"] = "tauri://drag-leave";
})(TauriEvent || (TauriEvent = {}));

// node_modules/@tauri-apps/api/window.js
var UserAttentionType;
(function(UserAttentionType2) {
  UserAttentionType2[UserAttentionType2["Critical"] = 1] = "Critical";
  UserAttentionType2[UserAttentionType2["Informational"] = 2] = "Informational";
})(UserAttentionType || (UserAttentionType = {}));
var ProgressBarStatus;
(function(ProgressBarStatus2) {
  ProgressBarStatus2["None"] = "none";
  ProgressBarStatus2["Normal"] = "normal";
  ProgressBarStatus2["Indeterminate"] = "indeterminate";
  ProgressBarStatus2["Paused"] = "paused";
  ProgressBarStatus2["Error"] = "error";
})(ProgressBarStatus || (ProgressBarStatus = {}));
var BackgroundThrottlingPolicy;
(function(BackgroundThrottlingPolicy2) {
  BackgroundThrottlingPolicy2["Disabled"] = "disabled";
  BackgroundThrottlingPolicy2["Throttle"] = "throttle";
  BackgroundThrottlingPolicy2["Suspend"] = "suspend";
})(BackgroundThrottlingPolicy || (BackgroundThrottlingPolicy = {}));
var ScrollBarStyle;
(function(ScrollBarStyle2) {
  ScrollBarStyle2["Default"] = "default";
  ScrollBarStyle2["FluentOverlay"] = "fluentOverlay";
})(ScrollBarStyle || (ScrollBarStyle = {}));
var Effect;
(function(Effect2) {
  Effect2["AppearanceBased"] = "appearanceBased";
  Effect2["Light"] = "light";
  Effect2["Dark"] = "dark";
  Effect2["MediumLight"] = "mediumLight";
  Effect2["UltraDark"] = "ultraDark";
  Effect2["Titlebar"] = "titlebar";
  Effect2["Selection"] = "selection";
  Effect2["Menu"] = "menu";
  Effect2["Popover"] = "popover";
  Effect2["Sidebar"] = "sidebar";
  Effect2["HeaderView"] = "headerView";
  Effect2["Sheet"] = "sheet";
  Effect2["WindowBackground"] = "windowBackground";
  Effect2["HudWindow"] = "hudWindow";
  Effect2["FullScreenUI"] = "fullScreenUI";
  Effect2["Tooltip"] = "tooltip";
  Effect2["ContentBackground"] = "contentBackground";
  Effect2["UnderWindowBackground"] = "underWindowBackground";
  Effect2["UnderPageBackground"] = "underPageBackground";
  Effect2["Mica"] = "mica";
  Effect2["Blur"] = "blur";
  Effect2["Acrylic"] = "acrylic";
  Effect2["Tabbed"] = "tabbed";
  Effect2["TabbedDark"] = "tabbedDark";
  Effect2["TabbedLight"] = "tabbedLight";
})(Effect || (Effect = {}));
var EffectState;
(function(EffectState2) {
  EffectState2["FollowsWindowActiveState"] = "followsWindowActiveState";
  EffectState2["Active"] = "active";
  EffectState2["Inactive"] = "inactive";
})(EffectState || (EffectState = {}));

// node_modules/@tauri-apps/plugin-fs/dist-js/index.js
var SeekMode;
(function(SeekMode2) {
  SeekMode2[SeekMode2["Start"] = 0] = "Start";
  SeekMode2[SeekMode2["Current"] = 1] = "Current";
  SeekMode2[SeekMode2["End"] = 2] = "End";
})(SeekMode || (SeekMode = {}));

// node_modules/@tauri-apps/api/app.js
var BundleType;
(function(BundleType2) {
  BundleType2["Nsis"] = "nsis";
  BundleType2["Msi"] = "msi";
  BundleType2["Deb"] = "deb";
  BundleType2["Rpm"] = "rpm";
  BundleType2["AppImage"] = "appimage";
  BundleType2["App"] = "app";
})(BundleType || (BundleType = {}));

// utils/desktop.ts
var AUDIO = ["mp3", "m4a"];
var PLAYABLE = ["mp4", "mov", "m4v", ...AUDIO];
var VIDEO_EXTS = [...PLAYABLE, "mkv", "avi", "webm", "wmv", "flv", "rmvb", "rm", "ts", "mts", "m2ts", "mpg", "mpeg", "vob", "3gp", "ogv"];
var dictList = () => invoke("dict_list");
var dictLookup = (ids, keys) => invoke("dict_lookup", { ids, keys });

// utils/japanese.ts
var import_react2 = __toESM(require_react(), 1);
var import_DynamicDictionaries = __toESM(require_DynamicDictionaries(), 1);
var import_Tokenizer = __toESM(require_Tokenizer(), 1);

// utils/jaPhrases.ts
var JA_PHRASES = {
  // greetings
  \u521D\u3081\u307E\u3057\u3066: "\u521D\u3081\u307E\u3057\u3066",
  \u3088\u308D\u3057\u304F\u304A\u9858\u3044\u3057\u307E\u3059: "\u3088\u308D\u3057\u304F\u304A\u9858\u3044\u3057\u307E\u3059",
  \u3088\u308D\u3057\u304F\u304A\u9858\u3044\u3044\u305F\u3057\u307E\u3059: "\u3088\u308D\u3057\u304F\u304A\u9858\u3044\u3057\u307E\u3059",
  \u304A\u9858\u3044\u3057\u307E\u3059: "\u304A\u9858\u3044\u3057\u307E\u3059",
  \u3042\u308A\u304C\u3068\u3046\u3054\u3056\u3044\u307E\u3059: "\u3042\u308A\u304C\u3068\u3046\u3054\u3056\u3044\u307E\u3059",
  \u3042\u308A\u304C\u3068\u3046\u3054\u3056\u3044\u307E\u3057\u305F: "\u3042\u308A\u304C\u3068\u3046\u3054\u3056\u3044\u307E\u3059",
  \u3059\u307F\u307E\u305B\u3093: "\u3059\u307F\u307E\u305B\u3093",
  \u3054\u3081\u3093\u306A\u3055\u3044: "\u3054\u3081\u3093\u306A\u3055\u3044",
  \u304A\u306F\u3088\u3046\u3054\u3056\u3044\u307E\u3059: "\u304A\u306F\u3088\u3046\u3054\u3056\u3044\u307E\u3059",
  \u3053\u3093\u306B\u3061\u306F: "\u3053\u3093\u306B\u3061\u306F",
  \u3053\u3093\u3070\u3093\u306F: "\u3053\u3093\u3070\u3093\u306F",
  \u3055\u3088\u3046\u306A\u3089: "\u3055\u3088\u3046\u306A\u3089",
  \u304A\u75B2\u308C\u69D8\u3067\u3059: "\u304A\u75B2\u308C\u69D8",
  \u304A\u75B2\u308C\u69D8\u3067\u3057\u305F: "\u304A\u75B2\u308C\u69D8\u3067\u3057\u305F",
  \u304A\u75B2\u308C\u3055\u307E\u3067\u3059: "\u304A\u75B2\u308C\u3055\u307E",
  \u304A\u75B2\u308C\u3055\u307E\u3067\u3057\u305F: "\u304A\u75B2\u308C\u69D8\u3067\u3057\u305F",
  \u3054\u3061\u305D\u3046\u3055\u307E\u3067\u3057\u305F: "\u3054\u99B3\u8D70\u69D8",
  \u3054\u3061\u305D\u3046\u3055\u307E: "\u3054\u99B3\u8D70\u69D8",
  \u5931\u793C\u3057\u307E\u3059: "\u5931\u793C\u3057\u307E\u3059",
  \u5931\u793C\u3057\u307E\u3057\u305F: "\u5931\u793C\u3057\u307E\u3059",
  \u304A\u90AA\u9B54\u3057\u307E\u3059: "\u304A\u90AA\u9B54\u3057\u307E\u3059",
  \u884C\u3063\u3066\u3089\u3063\u3057\u3083\u3044: "\u884C\u3063\u3066\u3089\u3063\u3057\u3083\u3044",
  \u304A\u5E30\u308A\u306A\u3055\u3044: "\u304A\u5E30\u308A\u306A\u3055\u3044",
  \u304A\u304B\u3048\u308A\u306A\u3055\u3044: "\u304A\u5E30\u308A\u306A\u3055\u3044",
  \u304A\u4E45\u3057\u3076\u308A\u3067\u3059: "\u304A\u4E45\u3057\u3076\u308A\u3067\u3059",
  \u3069\u3046\u3044\u305F\u3057\u307E\u3057\u3066: "\u3069\u3046\u3044\u305F\u3057\u307E\u3057\u3066",
  \u304B\u3057\u3053\u307E\u308A\u307E\u3057\u305F: "\u304B\u3057\u3053\u307E\u308A\u307E\u3057\u305F",
  \u304A\u5F85\u305F\u305B\u3057\u307E\u3057\u305F: "\u304A\u5F85\u305F\u305B\u3057\u307E\u3057\u305F",
  \u304A\u3081\u3067\u3068\u3046\u3054\u3056\u3044\u307E\u3059: "\u304A\u3081\u3067\u3068\u3046\u3054\u3056\u3044\u307E\u3059",
  \u304A\u5927\u4E8B\u306B: "\u304A\u5927\u4E8B\u306B",
  // expressions and grammar
  \u304B\u3082\u3057\u308C\u306A\u3044: "\u304B\u3082\u77E5\u308C\u306A\u3044",
  \u304B\u3082\u77E5\u308C\u306A\u3044: "\u304B\u3082\u77E5\u308C\u306A\u3044",
  \u304B\u3082\u3057\u308C\u307E\u305B\u3093: "\u304B\u3082\u3057\u308C\u307E\u305B\u3093",
  \u304B\u3082\u77E5\u308C\u307E\u305B\u3093: "\u304B\u3082\u3057\u308C\u307E\u305B\u3093",
  \u306B\u3082\u304B\u304B\u308F\u3089\u305A: "\u306B\u3082\u304B\u304B\u308F\u3089\u305A",
  \u306B\u3082\u62D8\u3089\u305A: "\u306B\u3082\u62D8\u3089\u305A",
  \u308F\u3051\u3067\u306F\u306A\u3044: "\u308F\u3051\u3067\u306F\u306A\u3044",
  \u308F\u3051\u3058\u3083\u306A\u3044: "\u308F\u3051\u3067\u306F\u306A\u3044",
  \u3068\u306F\u9650\u3089\u306A\u3044: "\u3068\u306F\u9650\u3089\u306A\u3044",
  \u6C17\u3092\u3064\u3051\u3066: "\u6C17\u3092\u3064\u3051\u308B",
  \u6C17\u3092\u3064\u3051\u308B: "\u6C17\u3092\u3064\u3051\u308B",
  \u6C17\u3092\u4ED8\u3051\u3066: "\u6C17\u3092\u4ED8\u3051\u308B",
  \u6C17\u3092\u4ED8\u3051\u308B: "\u6C17\u3092\u4ED8\u3051\u308B",
  \u306A\u3051\u308C\u3070\u306A\u3089\u306A\u3044: "\u306A\u3051\u308C\u3070\u306A\u3089\u306A\u3044",
  \u306A\u3051\u308C\u3070\u3044\u3051\u306A\u3044: "\u306A\u3051\u308C\u3070\u3044\u3051\u306A\u3044",
  \u306A\u304F\u3066\u306F\u306A\u3089\u306A\u3044: "\u306A\u304F\u3066\u306F\u306A\u3089\u306A\u3044",
  \u306A\u304F\u3066\u306F\u3044\u3051\u306A\u3044: "\u306A\u304F\u3066\u306F\u306A\u3089\u306A\u3044",
  \u3068\u3044\u3046\u306E\u306F: "\u3068\u3044\u3046\u306E\u306F",
  \u3068\u3044\u3046\u3088\u308A: "\u3068\u8A00\u3046\u3088\u308A",
  \u306B\u3068\u3063\u3066: "\u306B\u3068\u3063\u3066",
  \u306B\u3064\u3044\u3066: "\u306B\u3064\u3044\u3066",
  \u306B\u3088\u3063\u3066: "\u306B\u3088\u3063\u3066",
  \u306B\u5BFE\u3057\u3066: "\u306B\u5BFE\u3057\u3066",
  \u304B\u3089\u3068\u3044\u3063\u3066: "\u304B\u3089\u3068\u3044\u3063\u3066",
  \u305A\u306B\u306F\u3044\u3089\u308C\u306A\u3044: "\u305A\u306B\u306F\u3044\u3089\u308C\u306A\u3044",
  \u306B\u307B\u304B\u306A\u3089\u306A\u3044: "\u306B\u307B\u304B\u306A\u3089\u306A\u3044",
  \u306B\u4ED6\u306A\u3089\u306A\u3044: "\u306B\u307B\u304B\u306A\u3089\u306A\u3044",
  \u306B\u9055\u3044\u306A\u3044: "\u306B\u9055\u3044\u306A\u3044",
  \u306B\u3061\u304C\u3044\u306A\u3044: "\u306B\u9055\u3044\u306A\u3044",
  \u4ED5\u65B9\u304C\u306A\u3044: "\u4ED5\u65B9\u304C\u306A\u3044",
  \u3057\u3087\u3046\u304C\u306A\u3044: "\u3057\u3087\u3046\u304C\u306A\u3044"
};
var JA_SPELLING = {
  \u3084\u308B: "\u9063\u308B",
  \u304A\u304F: "\u7F6E\u304F",
  \u304F\u308B: "\u6765\u308B",
  \u3044\u3046: "\u8A00\u3046",
  \u3053\u3068: "\u4E8B",
  \u3044\u3044: "\u826F\u3044",
  \u3088\u3044: "\u826F\u3044"
};
var JA_PHRASE_LIST = Object.keys(JA_PHRASES).sort((a, b) => b.length - a.length);

// utils/japanese.ts
var tokenizer = null;
var isPunct = (m) => m.pos === "\u8A18\u53F7" || /^[\s\p{P}\p{S}]+$/u.test(m.s);
function jaMorphs(text) {
  if (!tokenizer) return null;
  let at = 0;
  const out = tokenizer.tokenize(text).map((t2) => {
    const m = {
      s: t2.surface_form,
      at,
      pos: t2.pos,
      d1: t2.pos_detail_1,
      base: t2.basic_form && t2.basic_form !== "*" ? t2.basic_form : t2.surface_form,
      reading: t2.reading && t2.reading !== "*" ? t2.reading : void 0,
      punct: isPunct({ pos: t2.pos, s: t2.surface_form })
    };
    at += m.s.length;
    return m;
  });
  return out.map((m) => m.s).join("") === text ? out : null;
}
function jaLemma(text) {
  const bare = text.replace(/^[\s\p{P}\p{S}]+/u, "");
  const phrase = JA_PHRASE_LIST.find((p) => bare.startsWith(p));
  if (phrase) return JA_PHRASES[phrase];
  const head = [];
  for (const m of jaMorphs(text) ?? []) {
    if (m.punct) continue;
    if (head.length && (m.pos === "\u52A9\u8A5E" || m.pos === "\u52A9\u52D5\u8A5E" || m.d1 === "\u975E\u81EA\u7ACB")) break;
    head.push(m);
  }
  if (head.length === 0) return JA_SPELLING[bare] ?? text;
  const last = head[head.length - 1];
  const lemma = head.slice(0, -1).map((m) => m.s).join("") + (last.s.startsWith("\u304F\u3060\u3055") ? "\u4E0B\u3055\u308B" : last.base);
  return JA_SPELLING[lemma] ?? lemma;
}

// utils/yomitanContent.ts
var ELIDED = /^(?:l|d|j|m|n|s|t|c|qu|jusqu|lorsqu|puisqu)'(?=\p{L})/iu;
function candidates(word, lang, lemma) {
  const w = word.trim().replace(/’/g, "'");
  const uniq = (xs) => [...new Set(xs.filter(Boolean))];
  if (lang === "ja") {
    const chars = [...w];
    const shorter = chars.slice(0, -1).map((_, i) => chars.slice(0, chars.length - 1 - i).join(""));
    return [uniq([word.trim(), lemma ?? ""]), uniq(shorter)];
  }
  const cases = (s) => {
    const lower = s.toLowerCase();
    const cap = lower.charAt(0).toUpperCase() + lower.slice(1);
    const out = [s, lower, cap];
    if (lang === "de") out.push(...out.map((x) => x.replace(/ß/g, "ss")), ...out.map((x) => x.replace(/ss/g, "\xDF")));
    return out;
  };
  const stripped = lang === "fr" && ELIDED.test(w) ? w.replace(ELIDED, "") : "";
  return [uniq([word.trim(), ...cases(w)]), uniq(stripped ? cases(stripped) : [])];
}
var formsOf = (row) => {
  const by = /* @__PURE__ */ new Map();
  for (const g of row[5]) {
    if (!Array.isArray(g) || typeof g[0] !== "string") continue;
    const how = Array.isArray(g[1]) ? g[1].filter((h) => typeof h === "string") : [];
    by.set(g[0], [...by.get(g[0]) ?? [], ...how]);
  }
  return [...by].map(([lemma, how]) => ({ lemma, how }));
};
var isFormRow = (row) => formsOf(row).length > 0;
var VARIANT = /* @__PURE__ */ new Set(["alt-of", "alternative", "misspelling"]);
var inflected = (how) => !how.some((h) => VARIANT.has(h));
function lemmasToFollow(rows, word) {
  const own = rows.some((r) => !isFormRow(r));
  const found = /* @__PURE__ */ new Map();
  for (const r of rows.filter(isFormRow)) {
    for (const f of formsOf(r)) {
      if (f.lemma === word || own && !inflected(f.how)) continue;
      const seen = found.get(f.lemma) ?? { how: [], inflection: false };
      seen.how.push(...f.how.filter((h) => !VARIANT.has(h)));
      seen.inflection ||= inflected(f.how);
      found.set(f.lemma, seen);
    }
  }
  return [...found.entries()].sort((a, b) => Number(b[1].inflection) - Number(a[1].inflection)).slice(0, 3).map(([lemma, v]) => ({ lemma, note: `${[...new Set(v.how)].slice(0, 2).join("; ") || "form"} of ${lemma}` }));
}
var BLOCK = /* @__PURE__ */ new Set(["div", "p", "li", "ol", "ul", "tr", "table", "details", "summary", "br"]);
var isNode = (n) => !!n && typeof n === "object" && !Array.isArray(n);
var kind = (n) => isNode(n) && n.data && typeof n.data.content === "string" ? n.data.content : "";
var kids = (n) => Array.isArray(n) ? n : isNode(n) ? Array.isArray(n.content) ? n.content : n.content == null ? [] : [n.content] : [];
function segs(n, skip = () => false) {
  const out = [];
  const push = (s) => {
    const last = out[out.length - 1];
    if (typeof last === "string") out[out.length - 1] = last + s;
    else out.push(s);
  };
  const walk = (x) => {
    if (typeof x === "string") return push(x);
    if (typeof x === "number") return push(String(x));
    if (Array.isArray(x)) return x.forEach(walk);
    if (!isNode(x) || skip(x) || x.tag === "img" || x.tag === "rt" || x.tag === "rp") return;
    if (x.tag === "ruby") {
      const base = kids(x).filter((c) => !(isNode(c) && (c.tag === "rt" || c.tag === "rp"))).map((c) => plain(segs(c))).join("");
      const rt = kids(x).filter((c) => isNode(c) && c.tag === "rt").map((c) => plain(segs(c.content))).join("");
      if (rt) out.push({ ruby: base, rt });
      else push(base);
      return;
    }
    const block = BLOCK.has(x.tag ?? "");
    if (block) push("\n");
    if (x.tag === "td" || x.tag === "th") push(" ");
    walk(x.content);
    if (block) push("\n");
  };
  walk(n);
  const tidy = out.map((p) => typeof p === "string" ? p.replace(/[ \t]*\n[\s]*/g, "\n") : p);
  if (typeof tidy[0] === "string") tidy[0] = tidy[0].replace(/^\n+/, "");
  const end = tidy.length - 1;
  if (typeof tidy[end] === "string") tidy[end] = tidy[end].replace(/\n+$/, "");
  return tidy.filter((p) => p !== "");
}
var plain = (line) => line.map((p) => typeof p === "string" ? p : "ruby" in p ? p.ruby : "").join("");
var find = (n, test, out = [], stopAtHit = true) => {
  if (Array.isArray(n)) n.forEach((c) => find(c, test, out, stopAtHit));
  else if (isNode(n)) {
    if (test(n)) {
      out.push(n);
      if (stopAtHit) return out;
    }
    find(n.content, test, out, stopAtHit);
  }
  return out;
};
function examplesIn(n) {
  return find(n, (x) => kind(x) === "example-sentence").map((ex) => {
    const a = find(ex, (x) => kind(x) === "example-sentence-a").flatMap((x) => segs(x));
    const b = find(ex, (x) => kind(x) === "example-sentence-b").flatMap((x) => segs(x, (y) => kind(y) === "attribution-footnote"));
    return b.length ? [...a, "\n", ...b] : a;
  }).filter((e) => plain(e).trim());
}
var NOT_MEANING = /* @__PURE__ */ new Set(["preamble", "backlink", "extra-info", "details-entry-examples", "formsTable", "references", "refGlosses", "sourceLanguages", "antonyms", "attribution-footnote", "forms", "xref"]);
var meaningOnly = (x) => NOT_MEANING.has(kind(x)) || x.tag === "details";
function sensesOf(item, pos) {
  if (typeof item === "string") return item.trim() ? [{ pos, text: [item], examples: [] }] : [];
  if (!isNode(item) || item.type !== "structured-content") return [];
  const tree = item.content;
  const lists = find(tree, (x) => kind(x) === "glosses");
  if (lists.length) {
    return lists.flatMap((l) => kids(l).filter(isNode).filter((li) => li.tag === "li")).map((li) => {
      const labels = find(li, (x) => kind(x) === "tags").flatMap((tg) => kids(tg).filter(isNode).map((x) => x.title ?? plain(segs(x))));
      return {
        pos: [pos, ...labels].filter(Boolean).join(", "),
        text: segs(li, (x) => meaningOnly(x) || kind(x) === "tags" || x.tag === "ol" || x.tag === "ul"),
        examples: examplesIn(li)
      };
    }).filter((s) => plain(s.text).trim());
  }
  const senses = find(tree, (x) => kind(x) === "sense");
  if (senses.length) {
    return find(tree, (x) => kind(x) === "sense-group").flatMap((group) => {
      const gpos = find(group, (x) => kind(x) === "part-of-speech-info", [], false).map((x) => x.title ?? plain(segs(x))).join(", ") || pos;
      return find(group, (x) => kind(x) === "sense").map((s) => ({
        pos: gpos,
        text: glossary(s),
        examples: examplesIn(s)
      }));
    }).filter((s) => plain(s.text).trim());
  }
  const gl = find(tree, (x) => kind(x) === "glossary");
  if (gl.length) {
    const notes = find(tree, (x) => kind(x) === "notes" || kind(x) === "infoGlossary").flatMap((x) => ["\n", ...segs(x)]);
    return [{ pos, text: [...glossary(tree), ...notes], examples: examplesIn(tree) }].filter((s) => plain(s.text).trim());
  }
  const text = segs(tree, (x) => kind(x) === "backlink");
  return plain(text).trim() ? [{ pos, text, examples: [] }] : [];
}
function glossary(n) {
  const items = find(n, (x) => kind(x) === "glossary").flatMap((g) => kids(g).filter(isNode).filter((li) => li.tag === "li"));
  const parts = items.map((li) => segs(li, meaningOnly));
  return parts.flatMap((p, i) => i ? ["; ", ...p] : p);
}
var posOf = (row, tags) => (row[2] ?? "").split(/\s+/).filter(Boolean).map((t2) => tags[t2]).filter((t2) => !!t2 && !!t2[1] && (t2[0] === "partOfSpeech" || (t2[0] ?? "").startsWith("gender"))).map((t2) => t2[1]).join(", ");
function toEntries(rows, tags, dictName, note) {
  const groups = /* @__PURE__ */ new Map();
  for (const r of rows) {
    if (isFormRow(r)) continue;
    const key = `${r[0]}\0${r[1]}\0${r[6] > 0 ? r[6] : ""}`;
    const pos = posOf(r, tags);
    const senses = r[5].flatMap((g) => sensesOf(g, pos));
    if (!senses.length) continue;
    const e = groups.get(key);
    if (e) e.senses.push(...senses);
    else {
      const reading = r[1] && r[1] !== r[0] ? r[1] : void 0;
      groups.set(key, { word: r[0], reading, phonetic: reading ?? "", senses, source: "local", dictName, note });
    }
  }
  return [...groups.values()];
}

// components/Dialog.tsx
var import_react4 = __toESM(require_react(), 1);

// components/ui.tsx
var import_react3 = __toESM(require_react(), 1);
var import_jsx_runtime = __toESM(require_jsx_runtime(), 1);

// components/Dialog.tsx
var import_jsx_runtime2 = __toESM(require_jsx_runtime(), 1);

// utils/localDict.ts
var state = { list: [], job: null, error: null, fresh: null };
var listeners = /* @__PURE__ */ new Set();
var set = (next) => {
  state = { ...state, ...next };
  listeners.forEach((f) => f());
};
var loaded = null;
function loadLocalDicts() {
  const read = dictList().then((list) => set({ list })).catch((e) => console.warn("Local dictionaries unreadable:", e));
  loaded = Promise.race([read, new Promise((r) => setTimeout(r, 3e3))]);
  return loaded;
}
var localDictsReady = () => loaded ?? loadLocalDicts();
var usable = (d) => d.enabled && !d.broken && !d.needsReimport && !!d.lang;
var localDictsFor = (lang) => state.list.filter((d) => usable(d) && d.lang === lang);
var dictLabel = (title) => title.replace(/\s*\[\d{4}-\d{2}-\d{2}\]\s*$/, "");
var wty = (src, tgt, mb) => {
  const path = `datasets/daxida/wty-release/resolve/main/latest/dict/${src}/${tgt}/wty-${src}-${tgt}.zip`;
  return { lang: src, title: `wty-${src}-${tgt}`, gloss: tgt, mb, urls: [`https://huggingface.co/${path}`, `https://hf-mirror.com/${path}`] };
};
var RECOMMENDED = [
  { lang: "ja", title: "Jitendex.org", gloss: "en", mb: 38, urls: ["https://github.com/stephenmk/stephenmk.github.io/releases/latest/download/jitendex-yomitan.zip"] },
  wty("ja", "zh", 7),
  wty("es", "zh", 3),
  wty("es", "en", 22),
  wty("fr", "zh", 3),
  wty("fr", "en", 11),
  wty("de", "zh", 6),
  wty("de", "en", 17),
  wty("en", "zh", 5),
  wty("en", "en", 108)
];
async function lookupLocal(word, lang) {
  await localDictsReady();
  const dicts = localDictsFor(lang);
  if (!dicts.length) return null;
  const ids = dicts.map((d) => d.id);
  const [first, second] = candidates(word, lang, lang === "ja" ? jaLemma(word) : void 0);
  let keys = first;
  let hits = await dictLookup(ids, keys);
  if (!hits.length && second.length) {
    hits = await dictLookup(ids, second);
    const best = lang === "ja" ? second.find((c) => hits.some((h) => h.rows.some((r) => r[0] === c || r[1] === c))) : void 0;
    keys = best ? [best] : second;
    if (best) hits = hits.map((h) => ({ ...h, rows: h.rows.filter((r) => r[0] === best || r[1] === best) })).filter((h) => h.rows.length);
  }
  if (!hits.length) return null;
  const lemmas = /* @__PURE__ */ new Map();
  for (const h of hits) lemmas.set(h.id, lemmasToFollow(h.rows, word));
  const wanted = [...new Set([...lemmas.values()].flat().map((l) => l.lemma))];
  const lemmaHits = wanted.length ? await dictLookup(ids, wanted) : [];
  const rank = (r) => {
    const i = keys.findIndex((k) => k === r[0] || k === r[1]);
    return i < 0 ? keys.length : i;
  };
  const out = [];
  for (const d of dicts) {
    const name = dictLabel(d.title);
    const own = hits.find((h) => h.id === d.id);
    if (own) {
      const rows = own.rows.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r) - rank(b.r) || (b.r[4] ?? 0) - (a.r[4] ?? 0) || a.i - b.i).map((x) => x.r);
      out.push(...toEntries(rows, own.tags, name));
    }
    const lh = lemmaHits.find((h) => h.id === d.id);
    for (const l of lemmas.get(d.id) ?? []) {
      if (lh) out.push(...toEntries(lh.rows.filter((r) => r[0] === l.lemma), lh.tags, name, l.note));
    }
  }
  return out.length ? out : null;
}

// utils/langDetect.ts
var STOPWORDS = {
  en: ["the", "and", "is", "you", "to", "of", "it", "that", "what", "this", "have", "with", "are", "was", "i", "my", "it's", "don't"],
  es: ["el", "la", "que", "y", "los", "las", "es", "por", "se", "una", "con", "para", "lo", "qu\xE9", "est\xE1", "pero", "yo", "muy"],
  fr: ["le", "la", "les", "et", "est", "que", "je", "vous", "pas", "une", "des", "du", "il", "ce", "qui", "c'est", "ne", "mais"],
  de: ["der", "die", "das", "und", "ist", "ich", "nicht", "zu", "ein", "eine", "sie", "es", "mit", "den", "dem", "auf", "wir", "du"],
  no: ["og", "er", "ikke", "jeg", "det", "p\xE5", "som", "har", "til", "vi", "av", "hva", "meg", "deg", "seg", "noe", "n\xE5", "mye"],
  da: ["og", "er", "ikke", "jeg", "det", "p\xE5", "som", "har", "til", "vi", "af", "hvad", "mig", "dig", "sig", "noget", "nu", "meget"]
};
var detectLang = (texts) => {
  const letters = texts.join("").match(/\p{L}/gu)?.length ?? 0;
  const kana = texts.join("").match(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu)?.length ?? 0;
  if (kana >= 5 && kana / letters >= 0.2) return "ja";
  const words = texts.join(" ").toLowerCase().replace(/[’`]/g, "'").match(/[\p{L}']+/gu) ?? [];
  if (words.length === 0) return null;
  const latin = words.filter((w) => /^[\p{Script=Latin}']+$/u.test(w)).length;
  if (latin / words.length < 0.8) return null;
  let best = null;
  let bestScore = 0;
  for (const lang of Object.keys(STOPWORDS)) {
    const set2 = new Set(STOPWORDS[lang]);
    const score = words.filter((w) => set2.has(w)).length;
    if (score > bestScore) {
      best = lang;
      bestScore = score;
    }
  }
  return bestScore >= 3 && best !== "da" ? best : null;
};

// utils/dictionary.ts
var OPTIONS = {
  zh: {
    en: ["youdao", "cambridge", "cambridgeEn", "wiktionary"],
    es: ["eudic", "youdao", "wiktionary", "cambridgeBi"],
    fr: ["eudic", "youdao", "wiktionary", "cambridgeBi"],
    de: ["eudic", "youdao", "wiktionary", "cambridgeBi"],
    ja: ["youdao", "wiktionary", "jisho"],
    no: ["wiktionary"]
  },
  en: {
    en: ["cambridgeEn", "wiktionary"],
    es: ["wiktionary", "cambridgeBi"],
    fr: ["wiktionary", "cambridgeBi"],
    de: ["wiktionary", "cambridgeBi"],
    ja: ["wiktionary", "jisho"],
    no: ["wiktionary"]
  }
};
var dictOptions = (ui = getLang()) => OPTIONS[ui];
var SOURCES_KEY = "linguaclip_dict_sources";
var readObj = (key) => {
  try {
    const v = JSON.parse(localStorage.getItem(key) || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
};
var storedSources = () => readObj(SOURCES_KEY);
var getDictSources = (ui = getLang()) => {
  const v = storedSources();
  return { online: v.online !== false, local: v.local !== false, localFirst: typeof v.localFirst === "boolean" ? v.localFirst : ui === "en", autoPick: v.autoPick === true, aiAlways: v.aiAlways === true, aiCulture: v.aiCulture === true };
};
var saveDictSources = (patch) => {
  try {
    localStorage.setItem(SOURCES_KEY, JSON.stringify({ ...storedSources(), ...patch }));
  } catch {
  }
};
var dictsOff = async (lang) => {
  const { online, local } = getDictSources();
  if (online) return null;
  await localDictsReady();
  if (!local) return "all";
  return localDictsFor(lang).length ? null : "noLocal";
};
var storageKey = (ui) => ui === "zh" ? "linguaclip_dict_choice" : "linguaclip_dict_choice_en";
var storedChoice = (ui) => readObj(storageKey(ui));
var getDictChoice = (ui = getLang()) => {
  const stored = storedChoice(ui);
  const options = dictOptions(ui);
  const pick = {};
  for (const lang of Object.keys(options)) {
    const v = stored[lang];
    pick[lang] = options[lang].includes(v) ? v : options[lang][0];
  }
  return pick;
};
var saveDictChoice = (lang, source, ui = getLang()) => {
  localStorage.setItem(storageKey(ui), JSON.stringify({ ...storedChoice(ui), [lang]: source }));
};
var clean = (s) => (s ?? "").replace(/\s+/g, " ").trim();
var CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;
var stripTags = (s) => clean(s.replace(/<[^>]+>/g, ""));
var collinsSenses = (list) => (list ?? []).flatMap((c) => c.entries?.entry ?? []).flatMap((x) => x.tran_entry ?? []).flatMap((t2) => {
  const tran = stripTags(t2.tran ?? "");
  if (!tran) return [];
  const i = tran.search(CJK);
  const en2 = i < 0 ? tran : tran.slice(0, i).trim();
  const zh2 = i < 0 ? "" : tran.slice(i).trim();
  const examples = (t2.exam_sents?.sent ?? []).filter((e) => e.eng_sent).map((e) => [clean(e.eng_sent) + (e.chn_sent ? `
${clean(e.chn_sent)}` : "")]);
  return [{ pos: clean(t2.pos_entry?.pos), text: [zh2 ? `${en2}
${zh2}` : en2], examples }];
});
var parseYoudao = (body, word) => {
  const w = body?.ec?.word ?? body?.fc?.word?.[0] ?? body?.multle?.word?.[0];
  const collins = collinsSenses(body?.collins?.collins_entries);
  const useCollins = collins.length >= 2 || collins.some((s) => s.examples.length > 0);
  const senses = useCollins ? collins : (w?.trs ?? []).map((t2) => ({
    pos: clean(t2.pos),
    text: clean(t2.tran ?? (t2.tr ?? []).flatMap((x) => x.l?.i ?? []).join("\uFF1B"))
  })).filter((s) => s.text && !/cop\s?yright/i.test(s.text)).map((s) => ({ pos: s.pos, text: [s.text], examples: [] }));
  if (senses.length === 0) return null;
  const rp = w?.["return-phrase"];
  const phonetic = w?.usphone || w?.ukphone || w?.phone || "";
  const headword = useCollins ? body.collins.collins_entries[0]?.headword : void 0;
  return {
    word: headword || (typeof rp === "string" ? rp : rp?.l?.i) || word,
    phonetic: phonetic ? `/${phonetic}/` : "",
    senses,
    source: "youdao"
  };
};
var jaEntry = (w) => {
  const senses = (w.sense ?? []).flatMap((s) => (s.phrList ?? []).flatMap((p) => {
    const zh2 = stripTags(p.jmsy ?? "");
    if (!zh2) return [];
    const ja = stripTags(p.jmsyT ?? "");
    const examples = (p.lj ?? []).map((l, i) => [[stripTags(l), stripTags(p.ljT?.[i] ?? "")].filter(Boolean).join("\n")]).filter((e) => e[0]);
    return [{ pos: clean(s.cx), text: [ja ? `${zh2}
${ja}` : zh2], examples }];
  }));
  if (senses.length === 0) return null;
  const { hw = "", pjm = "", tone = "" } = w.head ?? {};
  return { word: clean(hw), phonetic: clean(`${pjm !== hw ? pjm : ""} ${tone}`), senses, source: "youdao", reading: clean(pjm || hw) };
};
var parseYoudaoJa = (body) => {
  const w = body?.newjc?.word;
  if (!w) return null;
  const found = [w, ...w.homonymD ?? []].map(jaEntry).filter((e) => !!e);
  return found.length ? found : null;
};
var parseHtml = (html) => new DOMParser().parseFromString(html, "text/html");
var parseCambridge = (html, word, source = "cambridge") => {
  const doc = parseHtml(html);
  const bi = source === "cambridgeBi";
  const scope = source === "cambridge" ? doc : doc.querySelector(".pr.dictionary") ?? doc;
  const entries = [...scope.querySelectorAll(bi ? ".pr.di" : ".pr .entry-body__el")];
  const senses = [];
  for (const entry of entries) {
    const pos = clean(entry.querySelector(".posgram, .dpos-g")?.textContent);
    for (const block of entry.querySelectorAll(".def-block")) {
      const en2 = clean(block.querySelector(".ddef_h .def")?.textContent).replace(/:$/, "");
      const zh2 = clean(block.querySelector(".def-body > .trans")?.textContent);
      const examples = [...block.querySelectorAll(".def-body .examp")].map((x) => {
        const eg = clean(x.querySelector(".eg")?.textContent);
        const tr = clean(x.querySelector(".trans")?.textContent);
        return [tr ? `${eg}
${tr}` : eg];
      }).filter((x) => x[0]);
      if (bi ? zh2 : en2) senses.push({ pos, text: [bi ? en2 ? `${zh2}
${en2}` : zh2 : zh2 ? `${en2}
${zh2}` : en2], examples });
    }
  }
  if (senses.length === 0) return null;
  const first = entries[0];
  const ipa = clean(first?.querySelector(".us .ipa")?.textContent || first?.querySelector(".ipa")?.textContent);
  return { word: clean(first?.querySelector(".headword, .dhw")?.textContent) || word, phonetic: ipa ? `/${ipa}/` : "", senses, source };
};
var EUDIC_HOST = {
  es: "https://www.esdict.cn",
  fr: "https://www.frdic.com",
  de: "https://www.godic.net"
};
var GLYPH = /^https:\/\/www\.(esdict\.cn|frdic\.com|godic\.net)\/tmp\/wordimg\/[\w@=.-]+$/;
var pickEudicTerms = (terms, word) => {
  const lower = word.toLowerCase();
  const exact = terms.filter((t2) => t2.recordid && t2.recordtype !== "CG" && t2.value?.toLowerCase() === lower);
  const lemma = terms.filter((t2) => t2.recordid && t2.recordtype === "Dict" && t2.iscghint);
  return [...exact, ...lemma].filter((t2, i, all) => all.findIndex((x) => x.recordid === t2.recordid) === i).slice(0, 2);
};
var segs2 = (node, skip) => {
  const out = [];
  const walk = (n) => {
    if (skip && n !== node && n instanceof Element && n.matches(skip)) return;
    if (n.nodeType === Node.TEXT_NODE) out.push(n.textContent ?? "");
    else if (n instanceof Element && n.tagName === "BR") out.push("\n");
    else if (n instanceof Element && n.tagName === "IMG") {
      const src = n.getAttribute("src") ?? "";
      if (GLYPH.test(src)) out.push({ img: src });
    } else n.childNodes.forEach(walk);
  };
  walk(node);
  const merged = out.map((s) => typeof s === "string" && s !== "\n" ? s.replace(/\s+/g, " ") : s).filter((s, i, all) => !(s === "\n" && all[i - 1] === "\n"));
  while (typeof merged[0] === "string" && !merged[0].trim()) merged.shift();
  while (typeof merged[merged.length - 1] === "string" && !merged[merged.length - 1].trim()) merged.pop();
  return merged;
};
var lineText = (line) => line.map((p) => typeof p === "string" ? p : "ruby" in p ? p.ruby : "\u25A1").join("");
var hasCjk = (line) => line.some((p) => typeof p !== "string" || CJK.test(p));
var splitLines = (run) => {
  const lines = [[]];
  for (const p of run) {
    if (p === "\n") lines.push([]);
    else lines[lines.length - 1].push(p);
  }
  return lines.map((l) => l.map((p, i) => typeof p !== "string" ? p : i === 0 ? p.trimStart() : i === l.length - 1 ? p.trimEnd() : p)).filter((l) => lineText(l).trim());
};
var NUMBERED = /^\s*(\d+\s*\.|[①-⑳]|[⑴-⒇])/;
var groupSenses = (lines) => {
  const groups = [];
  for (const line of lines) {
    if (groups.length === 0 || NUMBERED.test(lineText(line))) groups.push([...line]);
    else groups[groups.length - 1].push("\n", ...line);
  }
  return groups;
};
var tilde = (line, word) => line.map((p) => typeof p === "string" && word ? p.replace(/~/g, word) : p);
var parseEudic = (html) => {
  const doc = parseHtml(html);
  const body = doc.querySelector("#ExpFCchild");
  if (!body) return null;
  const head = doc.querySelector("#exp-head");
  const word = clean(head?.querySelector(".word")?.textContent);
  body.querySelectorAll("script, a, [style]").forEach((n) => n.remove());
  const senses = [];
  let pos = "";
  let phrase = "";
  for (const el of body.querySelectorAll('.cara, .exp, .eg, [id="phrase"]')) {
    if (el.classList.contains("cara")) {
      pos = clean(el.textContent);
      phrase = "";
    } else if (el.id === "phrase") phrase = clean(el.textContent).replace(/~/g, word);
    else if (el.classList.contains("exp")) {
      for (const text of groupSenses(splitLines(segs2(el, ".exp, .eg")))) {
        senses.push(phrase ? { pos: "", phrase, text, examples: [] } : { pos, text, examples: [] });
      }
    } else {
      const last = senses[senses.length - 1];
      if (!last) continue;
      for (const line of splitLines(segs2(el)).map((l) => tilde(l, word))) {
        const prev = last.examples[last.examples.length - 1];
        if (prev && !hasCjk(prev) && hasCjk(line)) prev.push("\n", ...line);
        else last.examples.push(line);
      }
    }
  }
  if (senses.length === 0) {
    const cara = body.querySelector(".cara");
    pos = clean(cara?.textContent);
    cara?.remove();
    body.querySelectorAll(".eg").forEach((n) => n.remove());
    const groups = groupSenses(splitLines(segs2(body)));
    if (groups.length > 1 && !NUMBERED.test(lineText(groups[0]))) pos = clean(`${pos} ${lineText(groups.shift())}`);
    for (const text of groups) senses.push({ pos, text, examples: [] });
  }
  if (senses.length === 0) return null;
  return { word, phonetic: clean(head?.querySelector(".Phonitic")?.textContent), senses, source: "eudic" };
};
var get = async (url, ua = "Mozilla/5.0", ms = 15e3) => {
  const res = await fetch(url, { headers: { "User-Agent": ua, Origin: "" }, signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  return res;
};
var WIKI_UA = "LinguaClip (https://linguaclipapp.com; support@linguaclipapp.com)";
var wiktionary = async (word, lang) => {
  try {
    const body = await (await get(`https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(word)}`, WIKI_UA)).json();
    return parseWiktionary(body, word, lang);
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
};
var lookupWiktionary = async (word, lang) => {
  let found = await wiktionary(word, lang);
  if (!found && word !== word.toLowerCase()) found = await wiktionary(word.toLowerCase(), lang);
  if (!found) return null;
  const out = found.entry ? [found.entry] : [];
  const forms = found.forms.filter((f, i, all) => all.findIndex((x) => x.lemma === f.lemma) === i).slice(0, 2);
  for (const [i, lemma] of (await Promise.all(forms.map((f) => wiktionary(f.lemma, lang).catch(() => null)))).entries()) {
    if (lemma?.entry) out.push({ ...lemma.entry, note: forms[i].note });
  }
  if (out.length === 0 && forms.length) out.push({ word, phonetic: "", source: "wiktionary", senses: forms.map((f) => ({ pos: "", text: [f.note], examples: [] })) });
  return out.length ? out : null;
};
var CAMBRIDGE_BI = { es: "spanish-english", fr: "french-english", de: "german-english" };
var fromSource = async (source, word, lang) => {
  const q = encodeURIComponent(word);
  if (source === "cambridge" || source === "cambridgeEn" || source === "cambridgeBi" && CAMBRIDGE_BI[lang]) {
    const path = source === "cambridge" ? "english-chinese-simplified" : source === "cambridgeEn" ? "english" : CAMBRIDGE_BI[lang];
    const entry2 = parseCambridge(await (await get(`https://dictionary.cambridge.org/dictionary/${path}/${q}`, void 0, 8e3)).text(), word, source);
    return entry2 ? [entry2] : null;
  }
  if (source === "wiktionary") return lookupWiktionary(word, lang);
  if (source === "jisho" && lang === "ja") return parseJisho(await (await get(`https://jisho.org/api/v1/search/words?keyword=${q}`)).json(), word);
  if (source === "eudic" && (lang === "es" || lang === "fr" || lang === "de")) {
    const host = EUDIC_HOST[lang];
    const terms = pickEudicTerms(await (await get(`${host}/dicts/prefix/${q}`)).json(), word);
    const pages = await Promise.all(terms.map(async (t2) => parseEudic(await (await get(`${host}/dicts/${lang}/${encodeURIComponent(t2.value)}?recordid=${t2.recordid}`)).text())));
    const found = pages.filter((p) => !!p);
    return found.length ? found : null;
  }
  if (lang === "ja") return parseYoudaoJa(await (await get(`https://dict.youdao.com/jsonapi?le=jap&dicts=${encodeURIComponent('{"count":99,"dicts":[["newjc"]]}')}&q=${q}`)).json());
  const body = await (await get(`https://dict.youdao.com/jsonapi_s?doctype=json&jsonversion=4&le=${lang}&q=${q}`)).json();
  const entry = parseYoudao(body, word);
  return entry ? [entry] : null;
};
var lookupWord = async (word, lang) => {
  await localDictsReady();
  const ui = getLang();
  const { online, local, localFirst } = getDictSources(ui);
  const list = dictOptions(ui)[lang];
  const source = getDictChoice(ui)[lang];
  let failure = null;
  const fromOnline = async () => {
    if (!online) return null;
    for (const s of [.../* @__PURE__ */ new Set([source, ...list])]) {
      try {
        const found2 = await fromSource(s, word, lang);
        if (found2) return found2;
        if (!(s === source && s !== list[0])) {
          failure = null;
          return null;
        }
      } catch (e) {
        console.warn(`Dictionary ${s} unreachable:`, e);
        failure ??= e;
      }
    }
    return null;
  };
  const fromLocal = () => local ? lookupLocal(word, lang) : null;
  const found = localFirst ? await fromLocal() ?? await fromOnline() : await fromOnline() ?? await fromLocal();
  if (found) return found;
  if (failure) throw failure;
  return null;
};
var esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
var segsToHtml = (line) => line.map((p) => typeof p === "string" ? esc(p).replace(/\n/g, "<br/>") : "ruby" in p ? `<ruby>${esc(p.ruby)}<rt>${esc(p.rt)}</rt></ruby>` : `<img src="${p.img}">`).join("");
var senseToAnki = (entry, sense) => {
  const head = `<b>${esc(entry.word)}</b>${entry.phonetic ? ` ${esc(entry.phonetic)}` : ""}`;
  const meaning = [
    sense.pos && `<i>${esc(sense.pos)}</i>`,
    sense.phrase && `<b>${esc(sense.phrase)}</b>`,
    segsToHtml(sense.text)
  ].filter(Boolean).join(" ");
  return {
    definition: `${head}<br/>${meaning}`,
    example: sense.examples.slice(0, 2).map(segsToHtml).join("<br/><br/>")
  };
};
var senseList = (entries) => {
  const out = [];
  entries.forEach((e, entry) => e.senses.forEach((s, sense) => {
    const text = [e.word, s.pos, s.phrase, lineText(s.text).replace(/\n/g, " ")].filter(Boolean).join(" | ");
    const eg = s.examples[0] ? ` e.g. ${lineText(s.examples[0]).split("\n")[0]}` : "";
    out.push({ entry, sense, line: `${out.length + 1}. ${text}${eg}` });
  }));
  return out;
};
export {
  detectLang,
  dictOptions,
  dictsOff,
  getDictChoice,
  getDictSources,
  lookupWiktionary,
  lookupWord,
  parseCambridge,
  parseEudic,
  parseYoudao,
  parseYoudaoJa,
  pickEudicTerms,
  saveDictChoice,
  saveDictSources,
  senseList,
  senseToAnki
};
/*! Bundled license information:

react/cjs/react.development.js:
  (**
   * @license React
   * react.development.js
   *
   * Copyright (c) Meta Platforms, Inc. and affiliates.
   *
   * This source code is licensed under the MIT license found in the
   * LICENSE file in the root directory of this source tree.
   *)

react/cjs/react-jsx-runtime.development.js:
  (**
   * @license React
   * react-jsx-runtime.development.js
   *
   * Copyright (c) Meta Platforms, Inc. and affiliates.
   *
   * This source code is licensed under the MIT license found in the
   * LICENSE file in the root directory of this source tree.
   *)
*/
