; benchmark generated from python API
(set-info :status unknown)
(declare-fun stack_value () (_ BitVec 64))
(declare-fun stack_addr () (_ BitVec 32))
(declare-fun stack_live () (_ BitVec 64))
(assert
 (or (and (distinct stack_live stack_live) true) (and (distinct stack_addr stack_addr) true) (and (distinct stack_value stack_value) true)))
(check-sat)
