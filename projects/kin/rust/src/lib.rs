pub mod abi;
pub mod archive;
pub mod codec;
pub mod command;
pub mod core;
pub mod error;
pub mod event;
pub mod protocol;
pub mod recurrence;
pub mod state;

#[cfg(test)]
mod pulse_tests;

#[cfg(test)]
mod catchup_tests;

#[cfg(test)]
mod routine_tests;

#[cfg(test)]
mod command_tests;

#[cfg(test)]
mod area_tests;

#[cfg(test)]
mod note_tests;

#[cfg(test)]
mod step_tests;

#[cfg(test)]
mod mode_tests;

#[cfg(test)]
mod pin_tests;

#[cfg(test)]
mod playbook_tests;

#[cfg(test)]
mod maintenance_tests;

#[cfg(test)]
mod attachment_tests;

#[cfg(test)]
mod responsibility_tests;
