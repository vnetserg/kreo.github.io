// load wasm module and link with gl functions
//
// this file was made by tons of hacks from emscripten's parseTools and library_webgl
// https://github.com/emscripten-core/emscripten/blob/master/src/parseTools.js
// https://github.com/emscripten-core/emscripten/blob/master/src/library_webgl.js
//
// TODO: split to gl.js and loader.js

"use strict";

const canvas = document.querySelector("#glcanvas");
const gl = canvas.getContext("webgl");
if (gl === null) {
    alert("Unable to initialize WebGL. Your browser or machine may not support it.");
}

var clipboard = null;

var plugins = [];
var wasm_memory;

canvas.focus();

canvas.requestPointerLock = canvas.requestPointerLock ||
    canvas.mozRequestPointerLock;
document.exitPointerLock = document.exitPointerLock ||
    document.mozExitPointerLock;

function assert(flag, message) {
    if (flag == false) {
        alert(message)
    }
}

function acquireVertexArrayObjectExtension(ctx) {
    // Extension available in WebGL 1 from Firefox 25 and WebKit 536.28/desktop Safari 6.0.3 onwards. Core feature in WebGL 2.
    var ext = ctx.getExtension('OES_vertex_array_object');
    if (ext) {
        ctx['createVertexArray'] = function () { return ext['createVertexArrayOES'](); };
        ctx['deleteVertexArray'] = function (vao) { ext['deleteVertexArrayOES'](vao); };
        ctx['bindVertexArray'] = function (vao) { ext['bindVertexArrayOES'](vao); };
        ctx['isVertexArray'] = function (vao) { return ext['isVertexArrayOES'](vao); };
    }
    else {
        alert("Unable to get OES_vertex_array_object extension");
    }
}


function acquireInstancedArraysExtension(ctx) {
    // Extension available in WebGL 1 from Firefox 26 and Google Chrome 30 onwards. Core feature in WebGL 2.
    var ext = ctx.getExtension('ANGLE_instanced_arrays');
    if (ext) {
        ctx['vertexAttribDivisor'] = function (index, divisor) { ext['vertexAttribDivisorANGLE'](index, divisor); };
        ctx['drawArraysInstanced'] = function (mode, first, count, primcount) { ext['drawArraysInstancedANGLE'](mode, first, count, primcount); };
        ctx['drawElementsInstanced'] = function (mode, count, type, indices, primcount) { ext['drawElementsInstancedANGLE'](mode, count, type, indices, primcount); };
    }
}

acquireVertexArrayObjectExtension(gl);
acquireInstancedArraysExtension(gl);

// https://developer.mozilla.org/en-US/docs/Web/API/WEBGL_depth_texture
if (gl.getExtension('WEBGL_depth_texture') == null) {
    alert("Cant initialize WEBGL_depth_texture extension");
}

function getArray(ptr, arr, n) {
    return new arr(wasm_memory.buffer, ptr, n);
}

function UTF8ToString(ptr, maxBytesToRead) {
    let u8Array = new Uint8Array(wasm_memory.buffer, ptr);

    var idx = 0;
    var endIdx = idx + maxBytesToRead;

    var str = '';
    while (!(idx >= endIdx)) {
        // For UTF8 byte structure, see:
        // http://en.wikipedia.org/wiki/UTF-8#Description
        // https://www.ietf.org/rfc/rfc2279.txt
        // https://tools.ietf.org/html/rfc3629
        var u0 = u8Array[idx++];

        // If not building with TextDecoder enabled, we don't know the string length, so scan for \0 byte.
        // If building with TextDecoder, we know exactly at what byte index the string ends, so checking for nulls here would be redundant.
        if (!u0) return str;

        if (!(u0 & 0x80)) { str += String.fromCharCode(u0); continue; }
        var u1 = u8Array[idx++] & 63;
        if ((u0 & 0xE0) == 0xC0) { str += String.fromCharCode(((u0 & 31) << 6) | u1); continue; }
        var u2 = u8Array[idx++] & 63;
        if ((u0 & 0xF0) == 0xE0) {
            u0 = ((u0 & 15) << 12) | (u1 << 6) | u2;
        } else {

            if ((u0 & 0xF8) != 0xF0) console.warn('Invalid UTF-8 leading byte 0x' + u0.toString(16) + ' encountered when deserializing a UTF-8 string on the asm.js/wasm heap to a JS string!');

            u0 = ((u0 & 7) << 18) | (u1 << 12) | (u2 << 6) | (u8Array[idx++] & 63);
        }

        if (u0 < 0x10000) {
            str += String.fromCharCode(u0);
        } else {
            var ch = u0 - 0x10000;
            str += String.fromCharCode(0xD800 | (ch >> 10), 0xDC00 | (ch & 0x3FF));
        }
    }

    return str;
}

function stringToUTF8(str, heap, outIdx, maxBytesToWrite) {
    var startIdx = outIdx;
    var endIdx = outIdx + maxBytesToWrite;
    for (var i = 0; i < str.length; ++i) {
        // Gotcha: charCodeAt returns a 16-bit word that is a UTF-16 encoded code unit, not a Unicode code point of the character! So decode UTF16->UTF32->UTF8.
        // See http://unicode.org/faq/utf_bom.html#utf16-3
        // For UTF8 byte structure, see http://en.wikipedia.org/wiki/UTF-8#Description and https://www.ietf.org/rfc/rfc2279.txt and https://tools.ietf.org/html/rfc3629
        var u = str.charCodeAt(i); // possibly a lead surrogate
        if (u >= 0xD800 && u <= 0xDFFF) {
            var u1 = str.charCodeAt(++i);
            u = 0x10000 + ((u & 0x3FF) << 10) | (u1 & 0x3FF);
        }
        if (u <= 0x7F) {
            if (outIdx >= endIdx) break;
            heap[outIdx++] = u;
        } else if (u <= 0x7FF) {
            if (outIdx + 1 >= endIdx) break;
            heap[outIdx++] = 0xC0 | (u >> 6);
            heap[outIdx++] = 0x80 | (u & 63);
        } else if (u <= 0xFFFF) {
            if (outIdx + 2 >= endIdx) break;
            heap[outIdx++] = 0xE0 | (u >> 12);
            heap[outIdx++] = 0x80 | ((u >> 6) & 63);
            heap[outIdx++] = 0x80 | (u & 63);
        } else {
            if (outIdx + 3 >= endIdx) break;

            if (u >= 0x200000) console.warn('Invalid Unicode code point 0x' + u.toString(16) + ' encountered when serializing a JS string to an UTF-8 string on the asm.js/wasm heap! (Valid unicode code points should be in range 0-0x1FFFFF).');

            heap[outIdx++] = 0xF0 | (u >> 18);
            heap[outIdx++] = 0x80 | ((u >> 12) & 63);
            heap[outIdx++] = 0x80 | ((u >> 6) & 63);
            heap[outIdx++] = 0x80 | (u & 63);
        }
    }
    return outIdx - startIdx;
}
var FS = {
    loaded_files: [],
    unique_id: 0
};

var GL = {
    counter: 1,
    buffers: [],
    mappedBuffers: {},
    programs: [],
    framebuffers: [],
    renderbuffers: [],
    textures: [],
    uniforms: [],
    shaders: [],
    vaos: [],
    contexts: {},
    programInfos: {},

    getNewId: function (table) {
        var ret = GL.counter++;
        for (var i = table.length; i < ret; i++) {
            table[i] = null;
        }
        return ret;
    },

    validateGLObjectID: function (objectHandleArray, objectID, callerFunctionName, objectReadableType) {
        if (objectID != 0) {
            if (objectHandleArray[objectID] === null) {
                console.error(callerFunctionName + ' called with an already deleted ' + objectReadableType + ' ID ' + objectID + '!');
            } else if (!objectHandleArray[objectID]) {
                console.error(callerFunctionName + ' called with an invalid ' + objectReadableType + ' ID ' + objectID + '!');
            }
        }
    },
    getSource: function (shader, count, string, length) {
        var source = '';
        for (var i = 0; i < count; ++i) {
            var len = length == 0 ? undefined : getArray(length + i * 4, Uint32Array, 1)[0];
            source += UTF8ToString(getArray(string + i * 4, Uint32Array, 1)[0], len);
        }
        return source;
    },
    populateUniformTable: function (program) {
        GL.validateGLObjectID(GL.programs, program, 'populateUniformTable', 'program');
        var p = GL.programs[program];
        var ptable = GL.programInfos[program] = {
            uniforms: {},
            maxUniformLength: 0, // This is eagerly computed below, since we already enumerate all uniforms anyway.
            maxAttributeLength: -1, // This is lazily computed and cached, computed when/if first asked, "-1" meaning not computed yet.
            maxUniformBlockNameLength: -1 // Lazily computed as well
        };

        var utable = ptable.uniforms;
        // A program's uniform table maps the string name of an uniform to an integer location of that uniform.
        // The global GL.uniforms map maps integer locations to WebGLUniformLocations.
        var numUniforms = gl.getProgramParameter(p, 0x8B86/*GL_ACTIVE_UNIFORMS*/);
        for (var i = 0; i < numUniforms; ++i) {
            var u = gl.getActiveUniform(p, i);

            var name = u.name;
            ptable.maxUniformLength = Math.max(ptable.maxUniformLength, name.length + 1);

            // If we are dealing with an array, e.g. vec4 foo[3], strip off the array index part to canonicalize that "foo", "foo[]",
            // and "foo[0]" will mean the same. Loop below will populate foo[1] and foo[2].
            if (name.slice(-1) == ']') {
                name = name.slice(0, name.lastIndexOf('['));
            }

            // Optimize memory usage slightly: If we have an array of uniforms, e.g. 'vec3 colors[3];', then
            // only store the string 'colors' in utable, and 'colors[0]', 'colors[1]' and 'colors[2]' will be parsed as 'colors'+i.
            // Note that for the GL.uniforms table, we still need to fetch the all WebGLUniformLocations for all the indices.
            var loc = gl.getUniformLocation(p, name);
            if (loc) {
                var id = GL.getNewId(GL.uniforms);
                utable[name] = [u.size, id];
                GL.uniforms[id] = loc;

                for (var j = 1; j < u.size; ++j) {
                    var n = name + '[' + j + ']';
                    loc = gl.getUniformLocation(p, n);
                    id = GL.getNewId(GL.uniforms);

                    GL.uniforms[id] = loc;
                }
            }
        }
    }
}

function _glGenObject(n, buffers, createFunction, objectTable, functionName) {
    for (var i = 0; i < n; i++) {
        var buffer = gl[createFunction]();
        var id = buffer && GL.getNewId(objectTable);
        if (buffer) {
            buffer.name = id;
            objectTable[id] = buffer;
        } else {
            console.error("GL_INVALID_OPERATION");
            GL.recordError(0x0502 /* GL_INVALID_OPERATION */);

            alert('GL_INVALID_OPERATION in ' + functionName + ': GLctx.' + createFunction + ' returned null - most likely GL context is lost!');
        }
        getArray(buffers + i * 4, Int32Array, 1)[0] = id;
    }
}

function _webglGet(name_, p, type) {
    // Guard against user passing a null pointer.
    // Note that GLES2 spec does not say anything about how passing a null pointer should be treated.
    // Testing on desktop core GL 3, the application crashes on glGetIntegerv to a null pointer, but
    // better to report an error instead of doing anything random.
    if (!p) {
        console.error('GL_INVALID_VALUE in glGet' + type + 'v(name=' + name_ + ': Function called with null out pointer!');
        GL.recordError(0x501 /* GL_INVALID_VALUE */);
        return;
    }
    var ret = undefined;
    switch (name_) { // Handle a few trivial GLES values
        case 0x8DFA: // GL_SHADER_COMPILER
            ret = 1;
            break;
        case 0x8DF8: // GL_SHADER_BINARY_FORMATS
            if (type != 'EM_FUNC_SIG_PARAM_I' && type != 'EM_FUNC_SIG_PARAM_I64') {
                GL.recordError(0x500); // GL_INVALID_ENUM

                err('GL_INVALID_ENUM in glGet' + type + 'v(GL_SHADER_BINARY_FORMATS): Invalid parameter type!');
            }
            return; // Do not write anything to the out pointer, since no binary formats are supported.
        case 0x87FE: // GL_NUM_PROGRAM_BINARY_FORMATS
        case 0x8DF9: // GL_NUM_SHADER_BINARY_FORMATS
            ret = 0;
            break;
        case 0x86A2: // GL_NUM_COMPRESSED_TEXTURE_FORMATS
            // WebGL doesn't have GL_NUM_COMPRESSED_TEXTURE_FORMATS (it's obsolete since GL_COMPRESSED_TEXTURE_FORMATS returns a JS array that can be queried for length),
            // so implement it ourselves to allow C++ GLES2 code get the length.
            var formats = gl.getParameter(0x86A3 /*GL_COMPRESSED_TEXTURE_FORMATS*/);
            ret = formats ? formats.length : 0;
            break;
        case 0x821D: // GL_NUM_EXTENSIONS
            assert(false, "unimplemented");
            break;
        case 0x821B: // GL_MAJOR_VERSION
        case 0x821C: // GL_MINOR_VERSION
            assert(false, "unimplemented");
            break;
    }

    if (ret === undefined) {
        var result = gl.getParameter(name_);
        switch (typeof (result)) {
            case "number":
                ret = result;
                break;
            case "boolean":
                ret = result ? 1 : 0;
                break;
            case "string":
                GL.recordError(0x500); // GL_INVALID_ENUM
                console.error('GL_INVALID_ENUM in glGet' + type + 'v(' + name_ + ') on a name which returns a string!');
                return;
            case "object":
                if (result === null) {
                    // null is a valid result for some (e.g., which buffer is bound - perhaps nothing is bound), but otherwise
                    // can mean an invalid name_, which we need to report as an error
                    switch (name_) {
                        case 0x8894: // ARRAY_BUFFER_BINDING
                        case 0x8B8D: // CURRENT_PROGRAM
                        case 0x8895: // ELEMENT_ARRAY_BUFFER_BINDING
                        case 0x8CA6: // FRAMEBUFFER_BINDING
                        case 0x8CA7: // RENDERBUFFER_BINDING
                        case 0x8069: // TEXTURE_BINDING_2D
                        case 0x85B5: // WebGL 2 GL_VERTEX_ARRAY_BINDING, or WebGL 1 extension OES_vertex_array_object GL_VERTEX_ARRAY_BINDING_OES
                        case 0x8919: // GL_SAMPLER_BINDING
                        case 0x8E25: // GL_TRANSFORM_FEEDBACK_BINDING
                        case 0x8514: { // TEXTURE_BINDING_CUBE_MAP
                            ret = 0;
                            break;
                        }
                        default: {
                            GL.recordError(0x500); // GL_INVALID_ENUM
                            console.error('GL_INVALID_ENUM in glGet' + type + 'v(' + name_ + ') and it returns null!');
                            return;
                        }
                    }
                } else if (result instanceof Float32Array ||
                    result instanceof Uint32Array ||
                    result instanceof Int32Array ||
                    result instanceof Array) {
                    for (var i = 0; i < result.length; ++i) {
                        assert(false, "unimplemented")
                    }
                    return;
                } else {
                    try {
                        ret = result.name | 0;
                    } catch (e) {
                        GL.recordError(0x500); // GL_INVALID_ENUM
                        console.error('GL_INVALID_ENUM in glGet' + type + 'v: Unknown object returned from WebGL getParameter(' + name_ + ')! (error: ' + e + ')');
                        return;
                    }
                }
                break;
            default:
                GL.recordError(0x500); // GL_INVALID_ENUM
                console.error('GL_INVALID_ENUM in glGet' + type + 'v: Native code calling glGet' + type + 'v(' + name_ + ') and it returns ' + result + ' of type ' + typeof (result) + '!');
                return;
        }
    }

    switch (type) {
        case 'EM_FUNC_SIG_PARAM_I64': getArray(p, Int32Array, 1)[0] = ret;
        case 'EM_FUNC_SIG_PARAM_I': getArray(p, Int32Array, 1)[0] = ret; break;
        case 'EM_FUNC_SIG_PARAM_F': getArray(p, Float32Array, 1)[0] = ret; break;
        case 'EM_FUNC_SIG_PARAM_B': getArray(p, Int8Array, 1)[0] = ret ? 1 : 0; break;
        default: throw 'internal glGet error, bad type: ' + type;
    }
}

var Module;
var wasm_exports;

function resize(canvas, on_resize) {
    var displayWidth = canvas.clientWidth;
    var displayHeight = canvas.clientHeight;

    if (canvas.width != displayWidth ||
        canvas.height != displayHeight) {
        canvas.width = displayWidth;
        canvas.height = displayHeight;
        if (on_resize != undefined)
            on_resize(Math.floor(displayWidth), Math.floor(displayHeight))
    }
}

function animation() {
    wasm_exports.frame();
    window.requestAnimationFrame(animation);
}

const SAPP_EVENTTYPE_TOUCHES_BEGAN = 10;
const SAPP_EVENTTYPE_TOUCHES_MOVED = 11;
const SAPP_EVENTTYPE_TOUCHES_ENDED = 12;
const SAPP_EVENTTYPE_TOUCHES_CANCELLED = 13;

const SAPP_MODIFIER_SHIFT = 1;
const SAPP_MODIFIER_CTRL = 2;
const SAPP_MODIFIER_ALT = 4;
const SAPP_MODIFIER_SUPER = 8;

function into_sapp_mousebutton(btn) {
    switch (btn) {
        case 0: return 0;
        case 1: return 2;
        case 2: return 1;
        default: return btn;
    }
}

function into_sapp_keycode(key_code) {
    switch (key_code) {
        case "Space": return 32;
        case "Comma": return 44;
        case "Minus": return 45;
        case "Period": return 46;
        case "Digit0": return 48;
        case "Digit1": return 49;
        case "Digit2": return 50;
        case "Digit3": return 51;
        case "Digit4": return 52;
        case "Digit5": return 53;
        case "Digit6": return 54;
        case "Digit7": return 55;
        case "Digit8": return 56;
        case "Digit9": return 57;
        case "Semicolon": return 59;
        case "Equal": return 61;
        case "KeyA": return 65;
        case "KeyB": return 66;
        case "KeyC": return 67;
        case "KeyD": return 68;
        case "KeyE": return 69;
        case "KeyF": return 70;
        case "KeyG": return 71;
        case "KeyH": return 72;
        case "KeyI": return 73;
        case "KeyJ": return 74;
        case "KeyK": return 75;
        case "KeyL": return 76;
        case "KeyM": return 77;
        case "KeyN": return 78;
        case "KeyO": return 79;
        case "KeyP": return 80;
        case "KeyQ": return 81;
        case "KeyR": return 82;
        case "KeyS": return 83;
        case "KeyT": return 84;
        case "KeyU": return 85;
        case "KeyV": return 86;
        case "KeyW": return 87;
        case "KeyX": return 88;
        case "KeyY": return 89;
        case "KeyZ": return 90;
        case "BracketLeft": return 91;
        case "Backslash": return 92;
        case "BracketRight": return 93;
        case "Escape": return 256;
        case "Enter": return 257;
        case "Tab": return 258;
        case "Backspace": return 259;
        case "Insert": return 260;
        case "Delete": return 261;
        case "ArrowRight": return 262;
        case "ArrowLeft": return 263;
        case "ArrowDown": return 264;
        case "ArrowUp": return 265;
        case "PageUp": return 266;
        case "PageDown": return 267;
        case "Home": return 268;
        case "End": return 269;
        case "CapsLock": return 280;
        case "ScrollLock": return 281;
        case "NumLock": return 282;
        case "PrintScreen": return 283;
        case "Pause": return 284;
        case "F1": return 290;
        case "F2": return 291;
        case "F3": return 292;
        case "F4": return 293;
        case "F5": return 294;
        case "F6": return 295;
        case "F7": return 296;
        case "F8": return 297;
        case "F9": return 298;
        case "F10": return 299;
        case "F11": return 300;
        case "F12": return 301;
        case "F13": return 302;
        case "F14": return 303;
        case "F15": return 304;
        case "F16": return 305;
        case "F17": return 306;
        case "F18": return 307;
        case "F19": return 308;
        case "F20": return 309;
        case "F21": return 310;
        case "F22": return 311;
        case "F23": return 312;
        case "F24": return 313;
        case "Numpad0": return 320;
        case "Numpad1": return 321;
        case "Numpad2": return 322;
        case "Numpad3": return 323;
        case "Numpad4": return 324;
        case "Numpad5": return 325;
        case "Numpad6": return 326;
        case "Numpad7": return 327;
        case "Numpad8": return 328;
        case "Numpad9": return 329;
        case "NumpadDecimal": return 330;
        case "NumpadDivide": return 331;
        case "NumpadMultiply": return 332;
        case "NumpadSubstract": return 333;
        case "NumpadAdd": return 334;
        case "NumpadEnter": return 335;
        case "NumpadEqual": return 336;
        case "ShiftLeft": return 340;
        case "ControlLeft": return 341;
        case "AltLeft": return 342;
        case "OSLeft": return 343;
        case "ShiftRight": return 344;
        case "ControlRight": return 345;
        case "AltRight": return 346;
        case "OSRight": return 347;
        case "ContextMenu": return 348;
    }

    console.log("Unsupported keyboard key: ", key_code)
}

function texture_size(internalFormat, width, height) {
    if (internalFormat == gl.ALPHA) {
        return width * height;
    }
    else if (internalFormat == gl.RGB) {
        return width * height * 3;
    } else if (internalFormat == gl.RGBA) {
        return width * height * 4;
    } else { // TextureFormat::RGB565 | TextureFormat::RGBA4 | TextureFormat::RGBA5551
        return width * height * 3;
    }
}

function mouse_relative_position(clientX, clientY) {
    var targetRect = canvas.getBoundingClientRect();

    var x = clientX - targetRect.left;
    var y = clientY - targetRect.top;

    return { x, y };
}

var emscripten_shaders_hack = false;

var importObject = {
    env: {
        console_debug: function (ptr) {
            console.debug(UTF8ToString(ptr));
        },
        console_log: function (ptr) {
            console.log(UTF8ToString(ptr));
        },
        console_info: function (ptr) {
            console.info(UTF8ToString(ptr));
        },
        console_warn: function (ptr) {
            console.warn(UTF8ToString(ptr));
        },
        console_error: function (ptr) {
            console.error(UTF8ToString(ptr));
        },
        set_emscripten_shader_hack: function (flag) {
            emscripten_shaders_hack = flag;
        },
        sapp_set_clipboard: function(ptr, len) {
            clipboard = UTF8ToString(ptr, len);
        },
        rand: function () {
            return Math.floor(Math.random() * 2147483647);
        },
        now: function () {
            return Date.now() / 1000.0;
        },
        canvas_width: function () {
            return Math.floor(canvas.clientWidth);
        },
        canvas_height: function () {
            return Math.floor(canvas.clientHeight);
        },
        glClearDepthf: function (depth) {
            gl.clearDepth(depth);
        },
        glClearColor: function (r, g, b, a) {
            gl.clearColor(r, g, b, a);
        },
        glClearStencil: function (s) {
            gl.clearColorStencil(s);
        },
        glColorMask: function (red, green, blue, alpha) {
            gl.colorMask(red, green, blue, alpha);
        },
        glScissor: function (x, y, w, h) {
            gl.scissor(x, y, w, h);
        },
        glClear: function (mask) {
            gl.clear(mask);
        },
        glGenTextures: function (n, textures) {
            _glGenObject(n, textures, "createTexture", GL.textures, "glGenTextures")
        },
        glActiveTexture: function (texture) {
            gl.activeTexture(texture)
        },
        glBindTexture: function (target, texture) {
            GL.validateGLObjectID(GL.textures, texture, 'glBindTexture', 'texture');
            gl.bindTexture(target, GL.textures[texture]);
        },
        glTexImage2D: function (target, level, internalFormat, width, height, border, format, type, pixels) {
            gl.texImage2D(target, level, internalFormat, width, height, border, format, type,
                pixels ? getArray(pixels, Uint8Array, texture_size(internalFormat, width, height)) : null);
        },
        glTexSubImage2D: function (target, level, xoffset, yoffset, width, height, format, type, pixels) {
            gl.texSubImage2D(target, level, xoffset, yoffset, width, height, format, type,
                pixels ? getArray(pixels, Uint8Array, texture_size(format, width, height)) : null);
        },
        glTexParameteri: function (target, pname, param) {
            gl.texParameteri(target, pname, param);
        },
        glUniform1fv: function (location, count, value) {
            GL.validateGLObjectID(GL.uniforms, location, 'glUniform1fv', 'location');
            assert((value & 3) == 0, 'Pointer to float data passed to glUniform1fv must be aligned to four bytes!');
            var view = getArray(value, Float32Array, 1 * count);
            gl.uniform1fv(GL.uniforms[location], view);
        },
        glUniform2fv: function (location, count, value) {
            GL.validateGLObjectID(GL.uniforms, location, 'glUniform2fv', 'location');
            assert((value & 3) == 0, 'Pointer to float data passed to glUniform2fv must be aligned to four bytes!');
            var view = getArray(value, Float32Array, 2 * count);
            gl.uniform2fv(GL.uniforms[location], view);
        },
        glUniform3fv: function (location, count, value) {
            GL.validateGLObjectID(GL.uniforms, location, 'glUniform3fv', 'location');
            assert((value & 3) == 0, 'Pointer to float data passed to glUniform3fv must be aligned to four bytes!');
            var view = getArray(value, Float32Array, 3 * count);
            gl.uniform3fv(GL.uniforms[location], view);
        },
        glUniform4fv: function (location, count, value) {
            GL.validateGLObjectID(GL.uniforms, location, 'glUniform4fv', 'location');
            assert((value & 3) == 0, 'Pointer to float data passed to glUniform4fv must be aligned to four bytes!');
            var view = getArray(value, Float32Array, 4 * count);
            gl.uniform4fv(GL.uniforms[location], view);
        },
        glUniform1iv: function (location, count, value) {
            GL.validateGLObjectID(GL.uniforms, location, 'glUniform1fv', 'location');
            assert((value & 3) == 0, 'Pointer to i32 data passed to glUniform1iv must be aligned to four bytes!');
            var view = getArray(value, Int32Array, 1 * count);
            gl.uniform1iv(GL.uniforms[location], view);
        },
        glUniform2iv: function (location, count, value) {
            GL.validateGLObjectID(GL.uniforms, location, 'glUniform2fv', 'location');
            assert((value & 3) == 0, 'Pointer to i32 data passed to glUniform2iv must be aligned to four bytes!');
            var view = getArray(value, Int32Array, 2 * count);
            gl.uniform2iv(GL.uniforms[location], view);
        },
        glUniform3iv: function (location, count, value) {
            GL.validateGLObjectID(GL.uniforms, location, 'glUniform3fv', 'location');
            assert((value & 3) == 0, 'Pointer to i32 data passed to glUniform3iv must be aligned to four bytes!');
            var view = getArray(value, Int32Array, 3 * count);
            gl.uniform3iv(GL.uniforms[location], view);
        },
        glUniform4iv: function (location, count, value) {
            GL.validateGLObjectID(GL.uniforms, location, 'glUniform4fv', 'location');
            assert((value & 3) == 0, 'Pointer to i32 data passed to glUniform4iv must be aligned to four bytes!');
            var view = getArray(value, Int32Array, 4 * count);
            gl.uniform4iv(GL.uniforms[location], view);
        },
        glBlendFunc: function (sfactor, dfactor) {
            gl.blendFunc(sfactor, dfactor);
        },
        glBlendEquationSeparate: function (modeRGB, modeAlpha) {
            gl.blendEquationSeparate(modeRGB, modeAlpha);
        },
        glDisable: function (cap) {
            gl.disable(cap);
        },
        glDrawElements: function (mode, count, type, indices) {
            gl.drawElements(mode, count, type, indices);
        },
        glGetIntegerv: function (name_, p) {
            _webglGet(name_, p, 'EM_FUNC_SIG_PARAM_I');
        },
        glUniform1f: function (location, v0) {
            GL.validateGLObjectID(GL.uniforms, location, 'glUniform1f', 'location');
            gl.uniform1f(GL.uniforms[location], v0);
        },
        glUniform1i: function (location, v0) {
            GL.validateGLObjectID(GL.uniforms, location, 'glUniform1i', 'location');
            gl.uniform1i(GL.uniforms[location], v0);
        },
        glGetAttribLocation: function (program, name) {
            return gl.getAttribLocation(GL.programs[program], UTF8ToString(name));
        },
        glEnableVertexAttribArray: function (index) {
            gl.enableVertexAttribArray(index);
        },
        glDisableVertexAttribArray: function (index) {
            gl.disableVertexAttribArray(index);
        },
        glVertexAttribPointer: function (index, size, type, normalized, stride, ptr) {
            gl.vertexAttribPointer(index, size, type, !!normalized, stride, ptr);
        },
        glGetUniformLocation: function (program, name) {
            GL.validateGLObjectID(GL.programs, program, 'glGetUniformLocation', 'program');
            name = UTF8ToString(name);
            var arrayIndex = 0;
            // If user passed an array accessor "[index]", parse the array index off the accessor.
            if (name[name.length - 1] == ']') {
                var leftBrace = name.lastIndexOf('[');
                arrayIndex = name[leftBrace + 1] != ']' ? parseInt(name.slice(leftBrace + 1)) : 0; // "index]", parseInt will ignore the ']' at the end; but treat "foo[]" as "foo[0]"
                name = name.slice(0, leftBrace);
            }

            var uniformInfo = GL.programInfos[program] && GL.programInfos[program].uniforms[name]; // returns pair [ dimension_of_uniform_array, uniform_location ]
            if (uniformInfo && arrayIndex >= 0 && arrayIndex < uniformInfo[0]) { // Check if user asked for an out-of-bounds element, i.e. for 'vec4 colors[3];' user could ask for 'colors[10]' which should return -1.
                return uniformInfo[1] + arrayIndex;
            } else {
                return -1;
            }
        },
        glUniformMatrix4fv: function (location, count, transpose, value) {
            GL.validateGLObjectID(GL.uniforms, location, 'glUniformMatrix4fv', 'location');
            assert((value & 3) == 0, 'Pointer to float data passed to glUniformMatrix4fv must be aligned to four bytes!');
            var view = getArray(value, Float32Array, 16);
            gl.uniformMatrix4fv(GL.uniforms[location], !!transpose, view);
        },
        glUseProgram: function (program) {
            GL.validateGLObjectID(GL.programs, program, 'glUseProgram', 'program');
            gl.useProgram(GL.programs[program]);
        },
        glGenVertexArrays: function (n, arrays) {
            _glGenObject(n, arrays, 'createVertexArray', GL.vaos, 'glGenVertexArrays');
        },
        glGenFramebuffers: function (n, ids) {
            _glGenObject(n, ids, 'createFramebuffer', GL.framebuffers, 'glGenFramebuffers');
        },
        glBindVertexArray: function (vao) {
            gl.bindVertexArray(GL.vaos[vao]);
        },
        glBindFramebuffer: function (target, framebuffer) {
            GL.validateGLObjectID(GL.framebuffers, framebuffer, 'glBindFramebuffer', 'framebuffer');

            gl.bindFramebuffer(target, GL.framebuffers[framebuffer]);
        },

        glGenBuffers: function (n, buffers) {
            _glGenObject(n, buffers, 'createBuffer', GL.buffers, 'glGenBuffers');
        },
        glBindBuffer: function (target, buffer) {
            GL.validateGLObjectID(GL.buffers, buffer, 'glBindBuffer', 'buffer');
            gl.bindBuffer(target, GL.buffers[buffer]);
        },
        glBufferData: function (target, size, data, usage) {
            gl.bufferData(target, data ? getArray(data, Uint8Array, size) : size, usage);
        },
        glBufferSubData: function (target, offset, size, data) {
            gl.bufferSubData(target, offset, data ? getArray(data, Uint8Array, size) : size);
        },
        glEnable: function (cap) {
            gl.enable(cap);
        },
        glDepthFunc: function (func) {
            gl.depthFunc(func);
        },
        glBlendFuncSeparate: function (sfactorRGB, dfactorRGB, sfactorAlpha, dfactorAlpha) {
            gl.blendFuncSeparate(sfactorRGB, dfactorRGB, sfactorAlpha, dfactorAlpha);
        },
        glViewport: function (x, y, width, height) {
            gl.viewport(x, y, width, height);
        },
        glDrawArrays: function (mode, first, count) {
            gl.drawArrays(mode, first, count);
        },
        glCreateProgram: function () {
            var id = GL.getNewId(GL.programs);
            var program = gl.createProgram();
            program.name = id;
            GL.programs[id] = program;
            return id;
        },
        glAttachShader: function (program, shader) {
            GL.validateGLObjectID(GL.programs, program, 'glAttachShader', 'program');
            GL.validateGLObjectID(GL.shaders, shader, 'glAttachShader', 'shader');
            gl.attachShader(GL.programs[program], GL.shaders[shader]);
        },
        glLinkProgram: function (program) {
            GL.validateGLObjectID(GL.programs, program, 'glLinkProgram', 'program');
            gl.linkProgram(GL.programs[program]);
            GL.populateUniformTable(program);
        },
        glPixelStorei: function (pname, param) {
            gl.pixelStorei(pname, param);
        },
        glFramebufferTexture2D: function (target, attachment, textarget, texture, level) {
            GL.validateGLObjectID(GL.textures, texture, 'glFramebufferTexture2D', 'texture');
            gl.framebufferTexture2D(target, attachment, textarget, GL.textures[texture], level);
        },
        glGetProgramiv: function (program, pname, p) {
            assert(p);
            GL.validateGLObjectID(GL.programs, program, 'glGetProgramiv', 'program');
            if (program >= GL.counter) {
                console.error("GL_INVALID_VALUE in glGetProgramiv");
                return;
            }
            var ptable = GL.programInfos[program];
            if (!ptable) {
                console.error('GL_INVALID_OPERATION in glGetProgramiv(program=' + program + ', pname=' + pname + ', p=0x' + p.toString(16) + '): The specified GL object name does not refer to a program object!');
                return;
            }
            if (pname == 0x8B84) { // GL_INFO_LOG_LENGTH
                var log = gl.getProgramInfoLog(GL.programs[program]);
                assert(log !== null);

                getArray(p, Int32Array, 1)[0] = log.length + 1;
            } else if (pname == 0x8B87 /* GL_ACTIVE_UNIFORM_MAX_LENGTH */) {
                console.error("unsupported operation");
                return;
            } else if (pname == 0x8B8A /* GL_ACTIVE_ATTRIBUTE_MAX_LENGTH */) {
                console.error("unsupported operation");
                return;
            } else if (pname == 0x8A35 /* GL_ACTIVE_UNIFORM_BLOCK_MAX_NAME_LENGTH */) {
                console.error("unsupported operation");
                return;
            } else {
                getArray(p, Int32Array, 1)[0] = gl.getProgramParameter(GL.programs[program], pname);
            }
        },
        glCreateShader: function (shaderType) {
            var id = GL.getNewId(GL.shaders);
            GL.shaders[id] = gl.createShader(shaderType);
            return id;
        },
        glStencilFuncSeparate: function (face, func, ref_, mask) {
            gl.stencilFuncSeparate(face, func, ref_, mask);
        },
        glStencilMaskSeparate: function (face, mask) {
            gl.stencilMaskSeparate(face, mask);
        },
        glStencilOpSeparate: function (face, fail, zfail, zpass) {
            gl.stencilOpSeparate(face, fail, zfail, zpass);
        },
        glFrontFace: function (mode) {
            gl.frontFace(mode);
        },
        glCullFace: function (mode) {
            gl.cullFace(mode);
        },
        glCopyTexImage2D: function (target, level, internalformat, x, y, width, height, border) {
            gl.copyTexImage2D(target, level, internalformat, x, y, width, height, border);
        },

        glShaderSource: function (shader, count, string, length) {
            GL.validateGLObjectID(GL.shaders, shader, 'glShaderSource', 'shader');
            var source = GL.getSource(shader, count, string, length);

            // https://github.com/emscripten-core/emscripten/blob/incoming/src/library_webgl.js#L2708
            if (emscripten_shaders_hack) {
                source = source.replace(/#extension GL_OES_standard_derivatives : enable/g, "");
                source = source.replace(/#extension GL_EXT_shader_texture_lod : enable/g, '');
                var prelude = '';
                if (source.indexOf('gl_FragColor') != -1) {
                    prelude += 'out mediump vec4 GL_FragColor;\n';
                    source = source.replace(/gl_FragColor/g, 'GL_FragColor');
                }
                if (source.indexOf('attribute') != -1) {
                    source = source.replace(/attribute/g, 'in');
                    source = source.replace(/varying/g, 'out');
                } else {
                    source = source.replace(/varying/g, 'in');
                }

                source = source.replace(/textureCubeLodEXT/g, 'textureCubeLod');
                source = source.replace(/texture2DLodEXT/g, 'texture2DLod');
                source = source.replace(/texture2DProjLodEXT/g, 'texture2DProjLod');
                source = source.replace(/texture2DGradEXT/g, 'texture2DGrad');
                source = source.replace(/texture2DProjGradEXT/g, 'texture2DProjGrad');
                source = source.replace(/textureCubeGradEXT/g, 'textureCubeGrad');

                source = source.replace(/textureCube/g, 'texture');
                source = source.replace(/texture1D/g, 'texture');
                source = source.replace(/texture2D/g, 'texture');
                source = source.replace(/texture3D/g, 'texture');
                source = source.replace(/#version 100/g, '#version 300 es\n' + prelude);
            }

            gl.shaderSource(GL.shaders[shader], source);
        },
        glGetProgramInfoLog: function (program, maxLength, length, infoLog) {
            GL.validateGLObjectID(GL.programs, program, 'glGetProgramInfoLog', 'program');
            var log = gl.getProgramInfoLog(GL.programs[program]);
            assert(log !== null);
            let array = getArray(infoLog, Uint8Array, maxLength);
            for (var i = 0; i < maxLength; i++) {
                array[i] = log.charCodeAt(i);
            }
        },
        glCompileShader: function (shader, count, string, length) {
            GL.validateGLObjectID(GL.shaders, shader, 'glCompileShader', 'shader');
            gl.compileShader(GL.shaders[shader]);
        },
        glGetShaderiv: function (shader, pname, p) {
            assert(p);
            GL.validateGLObjectID(GL.shaders, shader, 'glGetShaderiv', 'shader');
            if (pname == 0x8B84) { // GL_INFO_LOG_LENGTH
                var log = gl.getShaderInfoLog(GL.shaders[shader]);
                assert(log !== null);

                getArray(p, Int32Array, 1)[0] = log.length + 1;

            } else if (pname == 0x8B88) { // GL_SHADER_SOURCE_LENGTH
                var source = gl.getShaderSource(GL.shaders[shader]);
                var sourceLength = (source === null || source.length == 0) ? 0 : source.length + 1;
                getArray(p, Int32Array, 1)[0] = sourceLength;
            } else {
                getArray(p, Int32Array, 1)[0] = gl.getShaderParameter(GL.shaders[shader], pname);
            }
        },
        glGetShaderInfoLog: function (shader, maxLength, length, infoLog) {
            GL.validateGLObjectID(GL.shaders, shader, 'glGetShaderInfoLog', 'shader');
            var log = gl.getShaderInfoLog(GL.shaders[shader]);
            assert(log !== null);
            let array = getArray(infoLog, Uint8Array, maxLength);
            for (var i = 0; i < maxLength; i++) {
                array[i] = log.charCodeAt(i);
            }
        },
        glVertexAttribDivisor: function (index, divisor) {
            gl.vertexAttribDivisor(index, divisor);
        },
        glDrawArraysInstanced: function (mode, first, count, primcount) {
            gl.drawArraysInstanced(mode, first, count, primcount);
        },
        glDrawElementsInstanced: function (mode, count, type, indices, primcount) {
            gl.drawElementsInstanced(mode, count, type, indices, primcount);
        },
        glDeleteShader: function (shader) { gl.deleteShader(shader) },
        glDeleteBuffers: function (n, buffers) {
            for (var i = 0; i < n; i++) {
                var id = getArray(buffers + i * 4, Uint32Array, 1)[0];
                var buffer = GL.buffers[id];

                // From spec: "glDeleteBuffers silently ignores 0's and names that do not
                // correspond to existing buffer objects."
                if (!buffer) continue;

                gl.deleteBuffer(buffer);
                buffer.name = 0;
                GL.buffers[id] = null;
            }
        },
        glDeleteFramebuffers: function (n, buffers) {
            for (var i = 0; i < n; i++) {
                var id = getArray(buffers + i * 4, Uint32Array, 1)[0];
                var buffer = GL.framebuffers[id];

                // From spec: "glDeleteFrameBuffers silently ignores 0's and names that do not
                // correspond to existing buffer objects."
                if (!buffer) continue;

                gl.deleteFramebuffer(buffer);
                buffer.name = 0;
                GL.framebuffers[id] = null;
            }
        },
        glDeleteTextures: function (n, textures) {
            for (var i = 0; i < n; i++) {
                var id = getArray(textures + i * 4, Uint32Array, 1)[0];
                var texture = GL.textures[id];
                if (!texture) continue; // GL spec: "glDeleteTextures silently ignores 0s and names that do not correspond to existing textures".
                gl.deleteTexture(texture);
                texture.name = 0;
                GL.textures[id] = null;
            }
        },
        init_opengl: function (ptr) {
            canvas.onmousemove = function (event) {
                var relative_position = mouse_relative_position(event.clientX, event.clientY);
                var x = relative_position.x;
                var y = relative_position.y;

                // TODO: do not send mouse_move when cursor is captured
                wasm_exports.mouse_move(Math.floor(x), Math.floor(y));

                // TODO: check that mouse is captured?
                if (event.movementX != 0 || event.movementY != 0) {
                    wasm_exports.raw_mouse_move(Math.floor(event.movementX), Math.floor(event.movementY));
                }
            };
            canvas.onmousedown = function (event) {
                var relative_position = mouse_relative_position(event.clientX, event.clientY);
                var x = relative_position.x;
                var y = relative_position.y;

                var btn = into_sapp_mousebutton(event.button);
                wasm_exports.mouse_down(x, y, btn);
            };
            // SO WEB SO CONSISTENT
            canvas.addEventListener('wheel',
                function (event) {
                    event.preventDefault();
                    wasm_exports.mouse_wheel(-event.deltaX, -event.deltaY);
                });
            canvas.onmouseup = function (event) {
                var relative_position = mouse_relative_position(event.clientX, event.clientY);
                var x = relative_position.x;
                var y = relative_position.y;

                var btn = into_sapp_mousebutton(event.button);
                wasm_exports.mouse_up(x, y, btn);
            };
            canvas.onkeydown = function (event) {
                var sapp_key_code = into_sapp_keycode(event.code);
                switch (sapp_key_code) {
                    //  space, arrows - prevent scrolling of the page
                    case 32: case 262: case 263: case 264: case 265:
                    // F1-F10
                    case 290: case 291: case 292: case 293: case 294: case 295: case 296: case 297: case 298: case 299:
                    // backspace is Back on Firefox/Windows
                    case 259:
                        event.preventDefault();
                        break;
                }

                var modifiers = 0;
                if (event.ctrlKey) {
                    modifiers |= SAPP_MODIFIER_CTRL;
                }
                if (event.shiftKey) {
                    modifiers |= SAPP_MODIFIER_SHIFT;
                }
                if (event.altKey) {
                    modifiers |= SAPP_MODIFIER_ALT;
                }
                wasm_exports.key_down(sapp_key_code, modifiers, event.repeat);
                // for "space" preventDefault will prevent
                // key_press event, so send it here instead
                if (sapp_key_code == 32) {
                    wasm_exports.key_press(sapp_key_code);
                }
            };
            canvas.onkeyup = function (event) {
                var sapp_key_code = into_sapp_keycode(event.code);
                wasm_exports.key_up(sapp_key_code);
            };
            canvas.onkeypress = function (event) {
                var sapp_key_code = into_sapp_keycode(event.code);

                // firefox do not send onkeypress events for ctrl+keys and delete key while chrome do
                // workaround to make this behavior consistent
                let chrome_only = sapp_key_code == 261 || event.ctrlKey;
                if (chrome_only == false) {
                    wasm_exports.key_press(event.charCode);
                }
            };

            canvas.addEventListener("touchstart", function (event) {
                event.preventDefault();

                for (touch of event.changedTouches) {
                    wasm_exports.touch(SAPP_EVENTTYPE_TOUCHES_BEGAN, touch.identifier, Math.floor(touch.clientX), Math.floor(touch.clientY));
                }
            });
            canvas.addEventListener("touchend", function (event) {
                event.preventDefault();

                for (touch of event.changedTouches) {
                    wasm_exports.touch(SAPP_EVENTTYPE_TOUCHES_ENDED, touch.identifier, Math.floor(touch.clientX), Math.floor(touch.clientY));
                }
            });
            canvas.addEventListener("touchcancel", function (event) {
                event.preventDefault();

                for (touch of event.changedTouches) {
                    wasm_exports.touch(SAPP_EVENTTYPE_TOUCHES_CANCELED, touch.identifier, Math.floor(touch.clientX), Math.floor(touch.clientY));
                }
            });
            canvas.addEventListener("touchmove", function (event) {
                event.preventDefault();

                for (touch of event.changedTouches) {
                    wasm_exports.touch(SAPP_EVENTTYPE_TOUCHES_MOVED, touch.identifier, Math.floor(touch.clientX), Math.floor(touch.clientY));
                }
            });

            window.onresize = function () {
                resize(canvas, wasm_exports.resize);
            };
            window.addEventListener("copy", function(e) {
                if (clipboard != null) {
                    event.clipboardData.setData('text/plain', clipboard);
                    event.preventDefault();
                }
            });
            window.addEventListener("cut", function(e) {
                if (clipboard != null) {
                    event.clipboardData.setData('text/plain', clipboard);
                    event.preventDefault();
                }
            });

            /*
            window.addEventListener("paste", function(e) {
                e.stopPropagation();
                e.preventDefault();
                var clipboardData = e.clipboardData || window.clipboardData;
                var pastedData = clipboardData.getData('Text');

                if (pastedData != undefined && pastedData != null && pastedData.length != 0) {
                    var len = pastedData.length;
                    var msg = wasm_exports.allocate_vec_u8(len);
                    var heap = new Uint8Array(wasm_memory.buffer, msg, len);
                    stringToUTF8(pastedData, heap, 0, len);
                    wasm_exports.on_clipboard_paste(msg, len);
                }
            });
            */

            window.requestAnimationFrame(animation);
        },

        fs_load_file: function (ptr, len) {
            var url = UTF8ToString(ptr, len);
            var file_id = FS.unique_id;
            FS.unique_id += 1;
            var xhr = new XMLHttpRequest();
            xhr.open('GET', url, true);
            xhr.responseType = 'arraybuffer';
            xhr.onload = function (e) {
                if (this.status == 200) {
                    var uInt8Array = new Uint8Array(this.response);

                    FS.loaded_files[file_id] = uInt8Array;
                    wasm_exports.file_loaded(file_id);
                }
            }
            xhr.onerror = function (e) {
                FS.loaded_files[file_id] = null;
                wasm_exports.file_loaded(file_id);
            };

            xhr.send();

            return file_id;
        },

        fs_get_buffer_size: function (file_id) {
            if (FS.loaded_files[file_id] == null) {
                return -1;
            } else {
                return FS.loaded_files[file_id].length;
            }
        },
        fs_take_buffer: function (file_id, ptr, max_length) {
            var file = FS.loaded_files[file_id];
            console.assert(file.length <= max_length);
            var dest = new Uint8Array(wasm_memory.buffer, ptr, max_length);
            for (var i = 0; i < file.length; i++) {
                dest[i] = file[i];
            }
            delete FS.loaded_files[file_id];
        },
        sapp_set_cursor_grab: function (grab) {
            if (grab) {
                canvas.requestPointerLock();
            } else {
                document.exitPointerLock();
            }
        }
    }
};


function register_plugins(plugins) {
    if (plugins == undefined)
        return;

    for (var i = 0; i < plugins.length; i++) {
        if (plugins[i].register_plugin != undefined && plugins[i].register_plugin != null) {
            plugins[i].register_plugin(importObject);
        }
    }
}

function init_plugins(plugins) {
    if (plugins == undefined)
        return;

    for (var i = 0; i < plugins.length; i++) {
        if (plugins[i].on_init != undefined && plugins[i].on_init != null) {
            plugins[i].on_init();
        }
    }
}


function miniquad_add_plugin(plugin) {
    plugins.push(plugin);
}

function load(wasm_path) {
    var req = fetch(wasm_path);

    register_plugins(plugins);

    if (typeof WebAssembly.instantiateStreaming === 'function') {
        WebAssembly.instantiateStreaming(req, importObject)
            .then(obj => {
                wasm_memory = obj.instance.exports.memory;
                wasm_exports = obj.instance.exports;

                init_plugins(plugins);
                obj.instance.exports.main();
            });
    } else {
        req
            .then(function (x) { return x.arrayBuffer(); })
            .then(function (bytes) { return WebAssembly.instantiate(bytes, importObject); })
            .then(function (obj) {
                wasm_memory = obj.instance.exports.memory;
                wasm_exports = obj.instance.exports;

                init_plugins(plugins);
                obj.instance.exports.main();
            });
    }
}

resize(canvas);

////////////////////////////////////////////////////////////////////////////////

/*
 * Copyright 2016 WebAssembly Community Group participants
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/*
 * Simple implmentation of WASI in JS in order to support running of tests
 * with minimal system dependencies such as the GCC torture tests.
 *
 * This script is designed to run under both d8 and nodejs.
 *
 * Usage: wasi.js <wasm_binary>
 */

var arguments_ = []

const PAGE_SIZE = (64 * 1024);
let heap_size_bytes = 16 * 1024 * 1024;
let heap_size_pages = heap_size_bytes / PAGE_SIZE;
let default_memory = new WebAssembly.Memory({initial: heap_size_pages, maximum: heap_size_pages})
let memory;
let heap;
let heap_uint8;
let heap_uint16;
let heap_uint32;

// This is node.js
if (typeof process === 'object' && typeof require === 'function') {
  // Emulate JS shell behavior used below
  var nodeFS = require('fs');
  var nodePath = require('path');
  var read = function(file_path) {
    filename = nodePath['normalize'](file_path);
    return nodeFS['readFileSync'](filename);
  }
  var print = console.log;
  var arguments_ = process['argv'].slice(2);
  var quit = process.exit
}

// Exceptions
function TerminateWasmException(value, code) {
  this.stack = (new Error()).stack;
  this.value = value;
  this.exit_code = code;
  this.message = 'Terminating WebAssembly';
  this.toString = function() { return this.message + ': ' + this.value; };
}

function NotYetImplementedException(what) {
  this.stack = (new Error()).stack;
  this.message = 'Not yet implemented';
  this.what = what;
  this.toString = function() { return this.message + ': ' + this.what; };
}

// Heap access helpers.
function setHeap(m) {
  memory = m
  heap = m.buffer
  heap_uint8 = new Uint8Array(heap);
  heap_uint16 = new Uint16Array(heap);
  heap_uint32 = new Uint32Array(heap);
  heap_size_bytes = heap.byteLength;
}

function checkHeap() {
  if (heap.byteLength == 0) {
    setHeap(wasm_memory);
  }
}

function readChar(ptr) {
  return String.fromCharCode(heap_uint8[ptr]);
}

function readStr(ptr, len = -1) {
  let str = '';
  var end = heap_size_bytes;
  if (len != -1)
    end = ptr + len;
  for (var i = ptr; i < end && heap_uint8[i] != 0; ++i)
    str += readChar(i);
  return str;
}

function writeBuffer(offset, buf) {
  buf.copy(heap_uint8, offset);
}

function writeStr(offset, str) {
  var start = offset;
  for (var i = 0; i < str.length; i++ ) {
    write8(offset, str.charCodeAt(i));
    offset++;
  }
  write8(offset, 0);
  offset++;
  return offset - start;
}

function write8(offset, value) { heap_uint8[offset] = value; }
function write16(offset, value) { heap_uint16[offset>>1] = value; }
function write32(offset, value) { heap_uint32[offset>>2] = value; }

function write64(offset, valueFirst, valueLast) {
  heap_uint32[(offset+0)>>2] = valueFirst;
  heap_uint32[(offset+4)>>2] = valueLast;
}

function read8(offset) { return heap_uint8[offset]; }
function read16(offset) { return heap_uint16[offset>>1]; }
function read32(offset) { return heap_uint32[offset>>2]; }

let DEBUG = false;

function dbg(message) {
  if (DEBUG)
    print(message);
}

// WASI implemenation
// See: https://github.com/WebAssembly/WASI/blob/master/design/WASI-core.md
var wasi_interface = (function() {
  const STDIN  = 0;
  const STDOUT = 1;
  const STDERR = 2;
  const MAXFD  = 2;

  const WASI_ESUCCESS = 0;
  const WASI_EBADF    = 8;
  const WASI_ENOTSUP  = 58;
  const WASI_EPERM    = 63;

  const WASI_PREOPENTYPE_DIR = 0;

  const WASI_LOOKUP_SYMLINK_FOLLOW = 0x1;

  const WASI_FDFLAG_APPEND   = 0x0001;
  const WASI_FDFLAG_DSYNC    = 0x0002;
  const WASI_FDFLAG_NONBLOCK = 0x0004;
  const WASI_FDFLAG_RSYNC    = 0x0008;
  const WASI_FDFLAG_SYNC     = 0x0010;

  const WASI_RIGHT_FD_DATASYNC       = 0x00000001;
  const WASI_RIGHT_FD_READ           = 0x00000002;
  const WASI_RIGHT_FD_SEEK           = 0x00000004;
  const WASI_RIGHT_PATH_OPEN         = 0x00002000;
  const WASI_RIGHT_PATH_FILESTAT_GET = 0x00040000;
  const WASI_RIGHT_FD_READDIR        = 0x00004000;
  const WASI_RIGHT_FD_FILESTAT_GET   = 0x00200000;
  const WASI_RIGHT_ALL               = 0xffffffff;

  const WASI_FILETYPE_UNKNOWN          = 0;
  const WASI_FILETYPE_BLOCK_DEVICE     = 1;
  const WASI_FILETYPE_CHARACTER_DEVICE = 2;
  const WASI_FILETYPE_DIRECTORY        = 3;
  const WASI_FILETYPE_REGULAR_FILE     = 4;
  const WASI_FILETYPE_SOCKET_DGRAM     = 5;
  const WASI_FILETYPE_SOCKET_STREAM    = 6;
  const WASI_FILETYPE_SYMBOLIC_LINK    = 7;

  const WASI_WHENCE_CUR = 0;
  const WASI_WHENCE_END = 1;
  const WASI_WHENCE_SET = 2;

  let env = {
    USER: 'alice',
  };

  let argv = [];

  let stdin = (function() {
    return {
      flush: function() {}
    };
  })();

  let stdout = (function() {
    let buf = '';
    return {
      type: WASI_FILETYPE_CHARACTER_DEVICE,
      flags: WASI_FDFLAG_APPEND,
      write: function(str) {
        buf += str;
        if (buf[-1] == '\n') {
          buf = buf.slice(0, -1);
          print(buf);
          buf = '';
        }
      },
      flush: function() {
        if (buf[-1] == '\n')
          buf = buf.slice(0, -1);
        print(buf);
        buf = '';
      }
    }
  })();

  let stderr = (function() {
    let buf = '';
    return {
      type: WASI_FILETYPE_CHARACTER_DEVICE,
      flags: WASI_FDFLAG_APPEND,
      write: function(str) {
        buf += str;
        if (buf[-1] == '\n') {
          buf = buf.slice(0, -1);
          print(buf);
          buf = '';
        }
      },
      flush: function() {
        if (buf[-1] == '\n')
          buf = buf.slice(0, -1);
        print(buf);
        buf = '';
      }
    }
  })();

  let rootdir = (function() {
    return {
      type: WASI_FILETYPE_DIRECTORY,
      flags: 0,
      flush: function() {},
      name: "/",
      rootdir: "/",
      preopen: true,
      rights_base: WASI_RIGHT_ALL,
      rights_inheriting: WASI_RIGHT_ALL,
    };
  })();

  let openFile = function(filename) {
    dbg('openFile: ' + filename);
    let data = read(filename);
    let position = 0;
    let end = data.length;
    return {
      read: function(len) {
        let start = position;
        let end = Math.min(position + len, data.length);
        position = end;
        return data.slice(start, end)
      },
      seek: function(offset, whence) {
        if (whence == WASI_WHENCE_CUR) {
          position += offset;
        } else if (whence == WASI_WHENCE_END) {
          position += end + offset;
        } else if (whence == WASI_WHENCE_SET) {
          position = offset;
        }
        if (position > end) {
          position = end;
        } else if (position < 0) {
          position = 0;
        }
        return position;
      },
      flush: function() {}
    };
  };

  let openFiles = [
    stdin,
    stdout,
    stderr,
    rootdir,
  ];

  let nextFD = openFiles.length;

  function isValidFD(fd) {
    return openFiles.hasOwnProperty(fd)
  }

  function trace(syscall_name, syscall_args) {
    if (DEBUG)
      dbg('wasi_snapshot_preview1.' + syscall_name + '(' + Array.from(syscall_args) + ')');
  }

  let module_api = {
    proc_exit: function(code) {
      trace('proc_exit', arguments_);
      throw new TerminateWasmException('proc_exit(' + code + ')', code);
    },
    environ_sizes_get: function(environ_count_out_ptr, environ_buf_size_out_ptr) {
      trace('environ_sizes_get', arguments_);
      checkHeap();
      const names = Object.getOwnPropertyNames(env);
      let total_space = 0;
      for (const i in names) {
        let name = names[i];
        let value = env[name];
        // Format of each env entry is name=value with null terminator.
        total_space += name.length + value.length + 2;
      }
      write64(environ_count_out_ptr, names.length);
      write64(environ_buf_size_out_ptr, total_space)
      return WASI_ESUCCESS;
    },
    environ_get: function(environ_pointers_out, environ_out) {
      trace('environ_get', arguments_);
      let names = Object.getOwnPropertyNames(env);
      for (const i in names) {
        write32(environ_pointers_out, environ_out);
        environ_pointers_out += 4;
        let name = names[i];
        let value = env[name];
        let full_string = name + "=" + value;
        environ_out += writeStr(environ_out, full_string);
      }
      write32(environ_pointers_out, 0);
      return WASI_ESUCCESS;
    },
    args_sizes_get: function(args_count_out_ptr, args_buf_size_out_ptr) {
      trace('args_sizes_get', arguments_);
      checkHeap();
      let total_space = 0;
      for (const value of argv) {
        total_space += value.length + 1;
      }
      write64(args_count_out_ptr, argv.length);
      write64(args_buf_size_out_ptr, total_space);
      dbg(argv);
      return WASI_ESUCCESS;
    },
    args_get: function(args_pointers_out, args_out) {
      trace('args_get', arguments_);
      for (const value of argv) {
        write32(args_pointers_out, args_out);
        args_pointers_out += 4;
        args_out += writeStr(args_out, value);
      }
      write32(args_pointers_out, 0);
      return WASI_ESUCCESS;
    },
    clock_time_get: function(id, precision) {
        return 0;
    },
    fd_pread: function(fd, iovs, iovs_len, offset, nread) {
      trace('fd_pread', arguments_);
      checkHeap();
      if (!isValidFD(fd))
        return WASI_EBADF;
      var file = openFiles[fd];
      if (fd.read == undefined)
        return WASI_EBADF;
      throw new NotYetImplementedException('fd_pread');
    },
    fd_prestat_get: function(fd, prestat_ptr) {
      trace('fd_prestat_get', arguments_);
      checkHeap();
      if (!isValidFD(fd))
        return WASI_EBADF;
      var file = openFiles[fd];
      if (!file.preopen)
        return WASI_EBADF;
      write8(prestat_ptr, WASI_PREOPENTYPE_DIR);
      write64(prestat_ptr+4, file.name.length);
      return 0;
    },
    fd_prestat_dir_name: function(fd, path_ptr, path_len) {
      trace('fd_prestat_dir_name', arguments_);
      if (!isValidFD(fd))
        return WASI_EBADF;
      var file = openFiles[fd];
      if (!file.preopen)
        return WASI_EBADF;
      write64(path_len, file.name.length);
      writeStr(path_ptr, file.name);
      return 0;
    },
    fd_fdstat_get: function(fd, fdstat_ptr) {
      trace('fd_fdstat_get', arguments_);
      if (!isValidFD(fd))
        return WASI_EBADF;
      var file = openFiles[fd];
      write8(fdstat_ptr, file.type);
      write16(fdstat_ptr+2, file.flags);
      write64(fdstat_ptr+8, file.rights_base);
      write64(fdstat_ptr+16, file.rights_inheriting);
      return WASI_ESUCCESS;
    },
    fd_fdstat_set_flags: function(fd, fdflags) {
      trace('fd_fdstat_set_flags', arguments_);
      if (!isValidFD(fd))
        return WASI_EBADF;
      return WASI_ESUCCESS;
    },
    fd_read: function(fd, iovs_ptr, iovs_len, nread) {
      trace('fd_read', arguments_);
      if (!isValidFD(fd))
        return WASI_EBADF;
      var file = openFiles[fd];
      if (!file.hasOwnProperty('read'))
        return WASI_EBADF;
      checkHeap();
      let total = 0;
      for (let i = 0; i < iovs_len; i++) {
        let buf = read32(iovs_ptr); iovs_ptr += 4;
        let len = read32(iovs_ptr); iovs_ptr += 4;
        let data = file.read(len);
        if (data.length == 0) {
          break;
        }
        writeBuffer(buf, data);
        total += data.length;
      }
      write32(nread, total);
      return WASI_ESUCCESS;
    },
    fd_readdir: function(fd, buf, buf_len, cookie) {
        return 0;
    },
    fd_sync: function(fd) {

    },
    fd_write: function(fd, iovs_ptr, iovs_len, nwritten) {
      trace('fd_write', arguments_);
      if (!isValidFD(fd))
        return WASI_EBADF;
      var file = openFiles[fd];
      if (!file.hasOwnProperty('write'))
        return WASI_EPERM;
      checkHeap();
      let total = 0;
      for (let i = 0; i < iovs_len; i++) {
        let buf = read32(iovs_ptr); iovs_ptr += 4;
        let len = read32(iovs_ptr); iovs_ptr += 4;
        file.write(readStr(buf, len));
        total += len;
      }
      write32(nwritten, total);
      return WASI_ESUCCESS;
    },
    fd_filestat_set_size : function(fd, size) {
        return 0;
    },
    fd_close: function(fd) {
      trace('fd_close', arguments_);
      if (!isValidFD(fd)) {
        return WASI_EBADF;
      }
      openFiles[fd].flush();
      delete openFiles[fd];
      if (fd < nextFD) {
        nextFD = fd;
      }
      return WASI_ESUCCESS;
    },
    fd_seek: function(fd, offset, whence, newoffset_ptr) {
      trace('fd_seek', arguments_);
      if (!isValidFD(fd)) {
        return WASI_EBADF;
      }
      let file = openFiles[fd];
      checkHeap();
      let intOffset = parseInt(offset.toString());
      let newPos = file.seek(intOffset, whence);
      write64(newoffset_ptr, newPos);
      dbg("done seek: " + newPos);
      return WASI_ESUCCESS;
    },
    path_filestat_get: function(dirfd, lookupflags, path, path_len, buf) {
      trace('path_filestat_get', arguments_);
      if (!isValidFD(dirfd)) {
        return WASI_EBADF;
      }
      let file = openFiles[dirfd];
      if (file != rootdir) {
        return WASI_EBADF;
      }
      let filename = readStr(path, path_len);
      let stat = nodeFS.statSync(filename);
      if (stat.isFile()) {
        write32(buf+16, WASI_FILETYPE_REGULAR_FILE);
      } else if (stat.isSymbolicLink()) {
        write32(buf+16, WASI_FILETYPE_SYMBOLIC_LINK);
      } else if (stat.isDirectory()) {
        write32(buf+16, WASI_FILETYPE_DIRECTORY);
      } else if (stat.isCharDevice()) {
        write32(buf+16, WASI_FILETYPE_CHARACTER_DEVICE);
      } else if (stat.isBlockDevice()) {
        write32(buf+16, WASI_FILETYPE_BLOCK_DEVICE);
      } else {
        write32(buf+16, WASI_FILETYPE_UNKNOWN);
      }
      return WASI_ESUCCESS;
    },
    path_create_directory: function(dirfd, path) {

    },
    path_link: function(old_fd, old_flags, old_path, new_fd, new_path) {

    },
    path_readlink: function(dirfd, path, buf, buf_len) {
        return 0;
    },
    path_open: function(dirfd, dirflags, path, path_len, oflags, fs_rights_base, fs_rights_inheriting, fs_flags, fd_out) {
      trace('path_open', arguments_);
      checkHeap();
      let filename = readStr(path, path_len);
      trace('path_open', ['dirfd=' + dirfd, 'path=' + filename, 'flags=' + oflags]);
      if (!isValidFD(dirfd))
        return WASI_EBADF;
      let file = openFiles[dirfd];
      if (file != rootdir)
        return WASI_EBADF;
      // TODO(sbc): Implement open flags (e.g. O_CREAT)
      if (oflags)
        return WASI_ENOTSUP;
      if (fs_flags)
        return WASI_ENOTSUP;
      let fd = nextFD;
      filename = file.rootdir + filename;
      openFiles[fd] = openFile(filename);
      write32(fd_out, fd);
      while (openFiles[nextFD] != undefined)
        nextFD++;
      return WASI_ESUCCESS;
    },
    path_unlink_file: function(dirfd, path, path_len) {
      checkHeap();
      let filename = readStr(path, path_len);
      trace('path_unlink_file', ['dirfd=' + dirfd, 'path=' + filename]);
      let file = openFiles[dirfd];
      if (file != rootdir)
        return WASI_EBADF;
      filename = file.rootdir + filename;
      trace('path_unlink_file', ['path=' + filename]);
      //fs.unlinkSync(filename);
      return WASI_ENOTSUP;
    },
    path_remove_directory: function(dirfd, path, path_len) {
      trace('path_remove_directory', ['dirfd=' + dirfd, 'path=' + readStr(path, path_len)]);
      throw new NotYetImplementedException('path_remove_directory');
    },
    path_rename: function(old_fd, old_path, new_fd, new_path) {

    },
    poll_oneoff: function(in_, out, nsub) {
        return 0;
    },
    sched_yield: function() {

    },
    random_get: function(buf, buf_len) {
      trace('random_get', arguments_);
      return WASI_ESUCCESS;
    }
  }

  return {
    onExit: function() {
      for (let k in openFiles){
        if (openFiles.hasOwnProperty(k)) {
          openFiles[k].flush();
        }
      }
    },
    setArgv: function(new_argv) {
      argv = new_argv;
    },
    api: module_api
  };
})();

let ffi = (function() {
  let env = {
    memory: default_memory,
    // Any non-wasi dependencies end up under 'env'.
    // TODO(sbc): Implement on the wasm side or add to WASI?
    _Unwind_RaiseException: function() {
      throw new NotYetImplementedException('_Unwind_RaiseException');
    }
  }
  return {
    env: env,
    wasi_snapshot_preview1: wasi_interface.api
  };
})();

miniquad_add_plugin({
    register_plugin: function(importObject) {
        importObject["wasi_snapshot_preview1"] = wasi_interface.api
    },
    on_init: function() {
        setHeap(wasm_memory);
        wasi_interface.setArgv([])
    },
})

////////////////////////////////////////////////////////////////////////////////

const heapBg = new Array(32).fill(undefined);

heapBg.push(undefined, null, true, false);

function getObject(idx) { return heapBg[idx]; }

let heap_next = heapBg.length;

function addHeapObject(obj) {
    if (heap_next === heapBg.length) heapBg.push(heapBg.length + 1);
    const idx = heap_next;
    heap_next = heapBg[idx];

    heapBg[idx] = obj;
    return idx;
}

function dropObject(idx) {
    if (idx < 36) return;
    heapBg[idx] = heap_next;
    heap_next = idx;
}

function takeObject(idx) {
    const ret = getObject(idx);
    dropObject(idx);
    return ret;
}

const lTextDecoder = typeof TextDecoder === 'undefined' ? (0, module.require)('util').TextDecoder : TextDecoder;

let cachedTextDecoder = new lTextDecoder('utf-8', { ignoreBOM: true, fatal: true });

cachedTextDecoder.decode();

let cachegetUint8Memory0 = null;
function getUint8Memory0() {
    if (cachegetUint8Memory0 === null || cachegetUint8Memory0.buffer !== wasm_exports.memory.buffer) {
        cachegetUint8Memory0 = new Uint8Array(wasm_exports.memory.buffer);
    }
    return cachegetUint8Memory0;
}

function getStringFromWasm0(ptr, len) {
    return cachedTextDecoder.decode(getUint8Memory0().subarray(ptr, ptr + len));
}

function makeClosure(arg0, arg1, dtor, f) {
    const state = { a: arg0, b: arg1, cnt: 1, dtor };
    const real = (...args) => {
        // First up with a closure we increment the internal reference
        // count. This ensures that the Rust closure environment won't
        // be deallocated while we're invoking it.
        state.cnt++;
        try {
            return f(state.a, state.b, ...args);
        } finally {
            if (--state.cnt === 0) {
                wasm_exports.__wbindgen_export_0.get(state.dtor)(state.a, state.b);
                state.a = 0;

            }
        }
    };
    real.original = state;

    return real;
}
function __wbg_adapter_10(arg0, arg1) {
    wasm_exports._dyn_core__ops__function__Fn_____Output___R_as_wasm_bindgen__closure__WasmClosure___describe__invoke__h60c8b610931eace5(arg0, arg1);
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

let WASM_VECTOR_LEN = 0;

const lTextEncoder = typeof TextEncoder === 'undefined' ? (0, module.require)('util').TextEncoder : TextEncoder;

let cachedTextEncoder = new lTextEncoder('utf-8');

const encodeString = (typeof cachedTextEncoder.encodeInto === 'function'
    ? function (arg, view) {
    return cachedTextEncoder.encodeInto(arg, view);
}
    : function (arg, view) {
    const buf = cachedTextEncoder.encode(arg);
    view.set(buf);
    return {
        read: arg.length,
        written: buf.length
    };
});

function passStringToWasm0(arg, malloc, realloc) {

    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length);
        getUint8Memory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len);

    const mem = getUint8Memory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }

    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3);
        const view = getUint8Memory0().subarray(ptr + offset, ptr + len);
        const ret = encodeString(arg, view);

        offset += ret.written;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

let cachegetInt32Memory0 = null;
function getInt32Memory0() {
    if (cachegetInt32Memory0 === null || cachegetInt32Memory0.buffer !== wasm_exports.memory.buffer) {
        cachegetInt32Memory0 = new Int32Array(wasm_exports.memory.buffer);
    }
    return cachegetInt32Memory0;
}

function handleError(f) {
    return function () {
        try {
            return f.apply(this, arguments);

        } catch (e) {
            wasm_exports.__wbindgen_exn_store(addHeapObject(e));
        }
    };
}

var bindgen_module = {

    __wbindgen_object_clone_ref: function(arg0) {
        var ret = getObject(arg0);
        return addHeapObject(ret);
    },

    __wbindgen_object_drop_ref: function(arg0) {
        takeObject(arg0);
    },

    __wbg_instanceof_Window_49f532f06a9786ee: function(arg0) {
        var ret = getObject(arg0) instanceof Window;
        return ret;
    },

    __wbg_document_c0366b39e4f4c89a: function(arg0) {
        var ret = getObject(arg0).document;
        return isLikeNone(ret) ? 0 : addHeapObject(ret);
    },

    __wbg_getElementById_15aef17a620252b4: function(arg0, arg1, arg2) {
        var ret = getObject(arg0).getElementById(getStringFromWasm0(arg1, arg2));
        return isLikeNone(ret) ? 0 : addHeapObject(ret);
    },

    __wbg_setonclick_1066084aa1dcedf5: function(arg0, arg1) {
        getObject(arg0).onclick = getObject(arg1);
    },

    __wbg_instanceof_HtmlTextAreaElement_aa81cb6ef637ad1f: function(arg0) {
        var ret = getObject(arg0) instanceof HTMLTextAreaElement;
        return ret;
    },

    __wbg_value_0938d95709a8299e: function(arg0, arg1) {
        var ret = getObject(arg1).value;
        var ptr0 = passStringToWasm0(ret, wasm_exports.__wbindgen_malloc, wasm_exports.__wbindgen_realloc);
        var len0 = WASM_VECTOR_LEN;
        getInt32Memory0()[arg0 / 4 + 1] = len0;
        getInt32Memory0()[arg0 / 4 + 0] = ptr0;
    },

    __wbg_setvalue_d48345fc605b6438: function(arg0, arg1, arg2) {
        getObject(arg0).value = getStringFromWasm0(arg1, arg2);
    },

    __wbg_instanceof_HtmlButtonElement_917edcddce3c8237: function(arg0) {
        var ret = getObject(arg0) instanceof HTMLButtonElement;
        return ret;
    },

    __wbg_call_951bd0c6d815d6f1: handleError(function(arg0, arg1) {
        var ret = getObject(arg0).call(getObject(arg1));
        return addHeapObject(ret);
    }),

    __wbg_newnoargs_7c6bd521992b4022: function(arg0, arg1) {
        var ret = new Function(getStringFromWasm0(arg0, arg1));
        return addHeapObject(ret);
    },

    __wbg_self_6baf3a3aa7b63415: handleError(function() {
        var ret = self.self;
        return addHeapObject(ret);
    }),

    __wbg_window_63fc4027b66c265b: handleError(function() {
        var ret = window.window;
        return addHeapObject(ret);
    }),

    __wbg_globalThis_513fb247e8e4e6d2: handleError(function() {
        var ret = globalThis.globalThis;
        return addHeapObject(ret);
    }),

    __wbg_global_b87245cd886d7113: handleError(function() {
        var ret = global.global;
        return addHeapObject(ret);
    }),

    __wbindgen_is_undefined: function(arg0) {
        var ret = getObject(arg0) === undefined;
        return ret;
    },

    __wbindgen_throw: function(arg0, arg1) {
        throw new Error(getStringFromWasm0(arg0, arg1));
    },

    __wbindgen_closure_wrapper243: function(arg0, arg1, arg2) {
        var ret = makeClosure(arg0, arg1, 86, __wbg_adapter_10);
        return addHeapObject(ret);
    },

}

miniquad_add_plugin({
    register_plugin: function(importObject) {
        importObject["./pathfind_demo_bg.js"] = bindgen_module
    },
})
