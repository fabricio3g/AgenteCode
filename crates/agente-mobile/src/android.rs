//! JNI returns a typed JSON envelope rather than unwinding across the boundary.
use jni::objects::{JClass, JString};
use jni::sys::jstring;
use jni::JNIEnv;
use serde_json::{json, Value};

fn argument(env: &mut JNIEnv<'_>, value: &JString<'_>) -> Result<String, String> {
    env.get_string(value)
        .map(String::from)
        .map_err(|_| "Invalid native argument".into())
}

fn reply(env: &mut JNIEnv<'_>, result: Result<String, String>) -> jstring {
    let response = match result {
        Ok(value) => {
            json!({"ok":true, "data":serde_json::from_str::<Value>(&value).unwrap_or(json!(value))})
        }
        Err(message) => json!({"ok":false, "error":message}),
    };
    match env.new_string(response.to_string()) {
        Ok(value) => value.into_raw(),
        Err(_) => {
            let _ = env.throw_new(
                "java/lang/IllegalStateException",
                "Native response unavailable",
            );
            std::ptr::null_mut()
        }
    }
}

#[no_mangle]
pub extern "system" fn Java_dev_agente_android_runtime_NativeBridge_nativeProviders(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
) -> jstring {
    reply(&mut env, Ok(super::providers_json()))
}

#[no_mangle]
pub extern "system" fn Java_dev_agente_android_runtime_NativeBridge_nativeStart(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
    raw: JString<'_>,
) -> jstring {
    let result = argument(&mut env, &raw).and_then(|raw| super::start(&raw));
    reply(&mut env, result)
}

#[no_mangle]
pub extern "system" fn Java_dev_agente_android_runtime_NativeBridge_nativePoll(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
    id: JString<'_>,
) -> jstring {
    let result = argument(&mut env, &id).and_then(|id| super::poll(&id));
    reply(&mut env, result)
}

#[no_mangle]
pub extern "system" fn Java_dev_agente_android_runtime_NativeBridge_nativeCancel(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
    id: JString<'_>,
) -> jstring {
    let result = argument(&mut env, &id).map(|id| {
        super::cancel(&id);
        "true".to_string()
    });
    reply(&mut env, result)
}

#[no_mangle]
pub extern "system" fn Java_dev_agente_android_runtime_NativeBridge_nativeDiscover(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
    provider: JString<'_>,
    key: JString<'_>,
) -> jstring {
    let result = argument(&mut env, &provider).and_then(|provider| {
        argument(&mut env, &key)
            .and_then(|key| super::runtime().block_on(super::discover_json(&provider, &key)))
    });
    reply(&mut env, result)
}

#[no_mangle]
pub extern "system" fn Java_dev_agente_android_runtime_NativeBridge_nativeMergeSync(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
    local: JString<'_>,
    incoming: JString<'_>,
) -> jstring {
    let result = argument(&mut env, &local).and_then(|local| {
        argument(&mut env, &incoming).and_then(|incoming| super::merge_sync_json(&local, &incoming))
    });
    reply(&mut env, result)
}
