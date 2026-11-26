; benchmark generated from python API
(set-info :status unknown)
(declare-fun stack_value () (_ BitVec 64))
(declare-fun stack_addr () (_ BitVec 32))
(assert
 (and (distinct ((_ zero_extend 32) stack_addr) stack_value) true))
(check-sat)
