use cabaret_types::Identity;

use crate::Setting;

impl Setting for Identity {
    const KEY: &'static str = "user.email";
}
