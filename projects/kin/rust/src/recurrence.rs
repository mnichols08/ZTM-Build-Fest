//! Civil periods for the proposed v0.7 contract. No clock or timestamp arithmetic.

use crate::error::KinError;

/// A validated Gregorian date, encoded as year * 10000 + month * 100 + day.
/// The private representation prevents invalid dates entering period arithmetic.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct CivilDate(u32);

impl CivilDate {
    pub fn from_encoded(value: u32) -> Result<Self, KinError> {
        let year = value / 10_000;
        let month = value / 100 % 100;
        let day = value % 100;
        if !(1..=9999).contains(&year)
            || !(1..=12).contains(&month)
            || day == 0
            || day > days_in_month(year, month)
        {
            return Err(KinError::MalformedProtocol);
        }
        Ok(Self(value))
    }

    pub const fn encoded(self) -> u32 {
        self.0
    }

    /// Days since 0001-01-01 (Monday), for calendar arithmetic only.
    fn ordinal(self) -> u32 {
        let year = self.0 / 10_000;
        let month = self.0 / 100 % 100;
        let previous_year = year - 1;
        let mut days =
            365 * previous_year + previous_year / 4 - previous_year / 100 + previous_year / 400;
        for preceding_month in 1..month {
            days += days_in_month(year, preceding_month);
        }
        days + self.0 % 100 - 1
    }

    fn from_ordinal(ordinal: u32) -> Self {
        let mut low = 1;
        let mut high = 10_000;
        while low + 1 < high {
            let middle = (low + high) / 2;
            let previous_year = middle - 1;
            let days_before_year =
                365 * previous_year + previous_year / 4 - previous_year / 100 + previous_year / 400;
            if days_before_year <= ordinal {
                low = middle;
            } else {
                high = middle;
            }
        }
        let previous_year = low - 1;
        let days_before_year =
            365 * previous_year + previous_year / 4 - previous_year / 100 + previous_year / 400;
        let mut day_of_year = ordinal - days_before_year;
        let mut month = 1;
        while day_of_year >= days_in_month(low, month) {
            day_of_year -= days_in_month(low, month);
            month += 1;
        }
        Self(low * 10_000 + month * 100 + day_of_year + 1)
    }

    pub fn monday(self) -> Self {
        let mut year = self.0 / 10_000;
        let mut month = self.0 / 100 % 100;
        let mut day = self.0 % 100;
        // At most six calendar steps. The minimum supported date is itself a
        // Monday, so this cannot cross the lower bound of the representation.
        for _ in 0..self.ordinal() % 7 {
            if day > 1 {
                day -= 1;
            } else {
                if month > 1 {
                    month -= 1;
                } else {
                    year -= 1;
                    month = 12;
                }
                day = days_in_month(year, month);
            }
        }
        Self(year * 10_000 + month * 100 + day)
    }
}

fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        4 | 6 | 9 | 11 => 30,
        2 if year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400)) => {
            29
        }
        2 => 28,
        _ => 31,
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum Cadence {
    Daily = 0,
    Weekly = 1,
    Biweekly = 2,
    Monthly = 3,
}

impl TryFrom<u8> for Cadence {
    type Error = KinError;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            0 => Ok(Self::Daily),
            1 => Ok(Self::Weekly),
            2 => Ok(Self::Biweekly),
            3 => Ok(Self::Monthly),
            _ => Err(KinError::MalformedProtocol),
        }
    }
}

impl Cadence {
    pub fn period_key(self, created_on: CivilDate, date: CivilDate) -> CivilDate {
        match self {
            Self::Daily => date,
            Self::Weekly => date.monday(),
            Self::Biweekly => {
                if date < created_on {
                    return date;
                }
                let elapsed = date.ordinal() - created_on.ordinal();
                CivilDate::from_ordinal(date.ordinal() - elapsed % 14)
            }
            Self::Monthly => CivilDate(date.0 / 100 * 100 + 1),
        }
    }

    /// A definition has no current occurrence before its creation civil date.
    /// Archival and completion belong to replay, not calendar arithmetic.
    pub fn current_key(self, created_on: CivilDate, today: CivilDate) -> Option<CivilDate> {
        (today >= created_on).then(|| self.period_key(created_on, today))
    }

    /// Historical key validity is independent of the current projection date.
    /// Otherwise clock rollback could invalidate an already saved event stream.
    pub fn validate_key(self, created_on: CivilDate, key: CivilDate) -> Result<(), KinError> {
        if key < self.period_key(created_on, created_on) || self.period_key(created_on, key) != key
        {
            return Err(KinError::InvalidEvent);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{Cadence, CivilDate};
    use crate::error::KinError;

    fn date(value: u32) -> CivilDate {
        CivilDate::from_encoded(value).unwrap()
    }

    #[test]
    fn civil_dates_reject_impossible_fields_and_overflow_values() {
        for value in [
            0,
            101,
            9999,
            20260001,
            20261301,
            20260100,
            20260132,
            20260431,
            20260229,
            20240230,
            19000229,
            21000229,
            100000101,
            u32::MAX,
        ] {
            assert_eq!(
                CivilDate::from_encoded(value),
                Err(KinError::MalformedProtocol),
                "{value}"
            );
        }
        for value in [10101, 99991231, 20000229, 20240229, 24000229] {
            assert_eq!(date(value).encoded(), value);
        }
    }

    #[test]
    fn cadence_codes_are_explicit_and_unknown_values_fail() {
        assert_eq!(Cadence::try_from(0), Ok(Cadence::Daily));
        assert_eq!(Cadence::try_from(1), Ok(Cadence::Weekly));
        assert_eq!(Cadence::try_from(2), Ok(Cadence::Biweekly));
        assert_eq!(Cadence::try_from(3), Ok(Cadence::Monthly));
        assert_eq!(Cadence::Daily as u8, 0);
        assert_eq!(Cadence::Weekly as u8, 1);
        assert_eq!(Cadence::Biweekly as u8, 2);
        assert_eq!(Cadence::Monthly as u8, 3);
        for value in 4..=u8::MAX {
            assert_eq!(Cadence::try_from(value), Err(KinError::MalformedProtocol));
        }
    }

    #[test]
    fn daily_keys_follow_civil_dates_including_leap_day_and_long_suspension() {
        let created = date(20240228);
        assert_eq!(Cadence::Daily.current_key(created, date(20240227)), None);
        for value in [20240228, 20240229, 20240301, 20241231, 20250101, 99991231] {
            let today = date(value);
            assert_eq!(Cadence::Daily.current_key(created, today), Some(today));
            assert_eq!(Cadence::Daily.period_key(created, today), today);
        }
    }

    #[test]
    fn biweekly_periods_are_anchored_to_creation_and_span_calendar_boundaries() {
        let created = date(20240228);
        assert_eq!(Cadence::Biweekly.current_key(created, date(20240227)), None);
        for (today, expected) in [
            (20240228, 20240228),
            (20240229, 20240228),
            (20240312, 20240228),
            (20240313, 20240313),
            (20241231, 20241218),
            (20250101, 20250101),
        ] {
            assert_eq!(
                Cadence::Biweekly.current_key(created, date(today)),
                Some(date(expected)),
                "{today}"
            );
        }
        assert_eq!(
            Cadence::Biweekly.validate_key(created, date(20240313)),
            Ok(())
        );
        for invalid in [20240227, 20240312, 20240314] {
            assert_eq!(
                Cadence::Biweekly.validate_key(created, date(invalid)),
                Err(KinError::InvalidEvent)
            );
        }
        assert_eq!(
            Cadence::Biweekly.current_key(date(99991220), date(99991231)),
            Some(date(99991220))
        );
    }

    #[test]
    fn monthly_periods_use_calendar_months_and_leap_years() {
        let created = date(20240131);
        assert_eq!(Cadence::Monthly.current_key(created, date(20240130)), None);
        for (today, expected) in [
            (20240131, 20240101),
            (20240201, 20240201),
            (20240229, 20240201),
            (20240301, 20240301),
            (20241231, 20241201),
            (20250101, 20250101),
        ] {
            assert_eq!(
                Cadence::Monthly.current_key(created, date(today)),
                Some(date(expected)),
                "{today}"
            );
        }
        assert_eq!(
            Cadence::Monthly.validate_key(created, date(20240101)),
            Ok(())
        );
        assert_eq!(
            Cadence::Monthly.validate_key(created, date(20240201)),
            Ok(())
        );
        for invalid in [20231201, 20240202, 20240229] {
            assert_eq!(
                Cadence::Monthly.validate_key(created, date(invalid)),
                Err(KinError::InvalidEvent)
            );
        }
    }

    #[test]
    fn monday_keys_cross_month_year_and_century_boundaries() {
        // Fixed calendar anchors, including an ISO week-year boundary. The
        // contract uses the Monday date, never an ISO week number.
        for (input, expected) in [
            (10101, 10101),
            (10107, 10101),
            (10108, 10108),
            (19000301, 19000226),
            (20000229, 20000228),
            (20201228, 20201228),
            (20201231, 20201228),
            (20210101, 20201228),
            (20210103, 20201228),
            (20210104, 20210104),
            (20240229, 20240226),
            (20240303, 20240226),
            (20240304, 20240304),
            (99991231, 99991227),
        ] {
            assert_eq!(date(input).monday(), date(expected), "{input}");
        }
    }

    #[test]
    fn weekly_creation_allows_partial_week_but_not_precreation_projection() {
        let created = date(20261002); // Friday
        assert_eq!(Cadence::Weekly.current_key(created, date(20261001)), None);
        for today in [20261002, 20261003, 20261004] {
            assert_eq!(
                Cadence::Weekly.current_key(created, date(today)),
                Some(date(20260928))
            );
        }
        assert_eq!(
            Cadence::Weekly.current_key(created, date(20261005)),
            Some(date(20261005))
        );
        assert_eq!(
            Cadence::Weekly.current_key(created, date(20270101)),
            Some(date(20261228))
        );
    }

    #[test]
    fn historical_keys_validate_without_a_projection_clock() {
        let created = date(20261002);
        assert_eq!(
            Cadence::Daily.validate_key(created, date(20261001)),
            Err(KinError::InvalidEvent)
        );
        assert_eq!(Cadence::Daily.validate_key(created, created), Ok(()));
        assert_eq!(Cadence::Daily.validate_key(created, date(20990101)), Ok(()));
        assert_eq!(
            Cadence::Weekly.validate_key(created, date(20260928)),
            Ok(())
        );
        for invalid in [20260921, 20261002, 20261004] {
            assert_eq!(
                Cadence::Weekly.validate_key(created, date(invalid)),
                Err(KinError::InvalidEvent)
            );
        }
        assert_eq!(
            Cadence::Weekly.validate_key(created, date(20270104)),
            Ok(())
        );
    }

    #[test]
    fn repeated_and_backward_context_selects_the_same_period() {
        for cadence in [Cadence::Daily, Cadence::Weekly] {
            let created = date(20260301);
            let expected = cadence.current_key(created, date(20260308));
            for later in [20260309, 20261101, 20290101] {
                let _ = cadence.current_key(created, date(later));
                assert_eq!(cadence.current_key(created, date(20260308)), expected);
            }
            assert_eq!(cadence.current_key(created, date(20260228)), None);
        }
    }

    #[test]
    fn full_gregorian_cycle_has_contiguous_days_and_seven_day_periods() {
        let mut count = 0;
        let mut previous_monday = date(10101);
        for year in 1..=400 {
            for month in 1..=12 {
                for day in 1..=31 {
                    let Ok(current) = CivilDate::from_encoded(year * 10_000 + month * 100 + day)
                    else {
                        continue;
                    };
                    assert_eq!(current.ordinal(), count);
                    let monday = current.monday();
                    assert_eq!(monday.ordinal(), count - count % 7);
                    assert_eq!(monday.monday(), monday);
                    assert!(monday <= current);
                    if count % 7 != 0 {
                        assert_eq!(monday, previous_monday);
                    }
                    previous_monday = monday;
                    count += 1;
                }
            }
        }
        // Independent Gregorian-cycle total: 400 common years + 97 leap days.
        assert_eq!(count, 146_097);
        assert_eq!(date(4010101).monday(), date(4010101));
    }
}
